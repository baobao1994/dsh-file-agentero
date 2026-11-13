/**
 * Host half of the media preview: two authenticated Fetch routes that stream
 * one workspace video or audio file to the right-Sidebar document preview.
 *
 * Why a separate route instead of the existing preview reads:
 * the document preview can hand a body complete bytes (32 MiB cap) or pages of
 * text, neither of which a 2 GB screen recording survives. A `<video>` element
 * needs an HTTP URL that answers `Range`, so this module owns that URL. The
 * routes register on Connection's authenticated Fetch fence, which means the
 * browser's own session cookie admits the request — a media element cannot set
 * custom headers, so the plugin's other loopback routes cannot serve this.
 *
 * File authority is the platform's own: reads go through `workspaceFiles`
 * with the workspace scope resolved from the Session named in the query, exactly
 * what the preview already reads. This route adds no new access: it only serves
 * suffixes it claims, read-only.
 *
 * The range grammar, windowed reads and error mapping follow
 * @lifenrir/dsh-video-preview (MIT) — see THIRD_PARTY_NOTICES.md.
 */

/** Absolute paths below `/api`; the Fetch fence mounts them beside every other API route. */
export const MEDIA_STREAM_PATH = '/api/file-agentero/media';
export const MEDIA_STAT_PATH = '/api/file-agentero/media-stat';

/**
 * Suffix to media type. Only containers the bundled Chromium routinely decodes
 * are claimed: `mkv`, `avi`, `wmv` and `flv` stay with the preview's
 * unsupported empty state, where "open in another app" still applies.
 */
const MEDIA_TYPES = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  webv: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  weba: 'audio/webm',
};

/** Suffixes this renderer claims, derived from the type table. */
export const MEDIA_EXTENSIONS = Object.keys(MEDIA_TYPES);

/** Bytes requested per backend read; a response streams as many windows as it needs. */
const DEFAULT_WINDOW_BYTES = 1024 * 1024;
/** A backend with a smaller per-window cap is honoured by halving down to this floor. */
const MIN_WINDOW_BYTES = 64 * 1024;
/** Upper bound the browser may demand in one request; a longer range is clamped. */
const MAX_RANGE_BYTES = 512 * 1024 * 1024;

/** Lowercase suffix of a workspace path, without the dot. */
export function suffixOf(path) {
  const name = String(path ?? '');
  const tail = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = tail.lastIndexOf('.');
  return dot <= 0 ? '' : tail.slice(dot + 1).toLowerCase();
}

/**
 * Media type for a path this renderer claims.
 * @param path - workspace path or file address.
 * @returns the media type, or undefined for a suffix this route refuses.
 */
export function mediaTypeOf(path) {
  return Object.hasOwn(MEDIA_TYPES, suffixOf(path)) ? MEDIA_TYPES[suffixOf(path)] : undefined;
}

/** Whether the route may serve this path at all; everything else answers 415. */
export function isMediaPath(path) {
  return mediaTypeOf(path) !== undefined;
}

/**
 * Parse one byte `Range` header against a known size.
 *
 * Only the single-range forms browsers send are understood (`bytes=a-b`,
 * `bytes=a-`, `bytes=-n`); a multipart range is refused rather than
 * half-served. The result is always clamped to the file, so a response never
 * promises bytes past EOF.
 *
 * @param raw - the header value, or null when the request carried none.
 * @param size - the file's byte size.
 * @returns null without a header, `'invalid'` for a malformed or
 *   unsatisfiable request, or the `{ offset, length }` window (length 0 means
 *   the start lies at or past EOF).
 */
export function parseRange(raw, size) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^bytes=/i.test(value)) return 'invalid';
  const spec = value.slice('bytes='.length).trim();
  if (spec.includes(',')) return 'invalid';
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null) return 'invalid';
  const [, from, to] = match;
  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    const suffix = Number(to);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    if (size === 0) return { offset: 0, length: 0 };
    const offset = Math.max(0, size - suffix);
    return { offset, length: size - offset };
  }
  const start = Number(from);
  if (!Number.isSafeInteger(start) || start < 0) return 'invalid';
  if (start >= size) return { offset: start, length: 0 };
  if (to === '') return { offset: start, length: size - start };
  const end = Number(to);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

/** Plain-text response with an explicit type; these routes serve no HTML. */
function text(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Read `sessionId` and `path` from the query, or the 400 answering instead. */
function coordinates(request) {
  const query = new URL(request.url).searchParams;
  const sessionId = query.get('sessionId');
  const path = query.get('path');
  if (typeof sessionId !== 'string' || sessionId === '' || typeof path !== 'string' || path === '') {
    return text(400, 'sessionId and path are required.');
  }
  return { sessionId, path };
}

/**
 * Resolve the workspace root for one Session identity.
 * The media tab always addresses a live Session, so a header that is not in
 * memory is a 404 rather than a second persistence lookup.
 */
function scopeOf(ctx, sessionId) {
  const header = ctx.sessions.get(sessionId)?.header;
  if (header === undefined) return undefined;
  return { sessionId, workspaceRoot: header.cwd ?? ctx.sandboxPolicy.workspaceRoot };
}

/** Map a `workspaceFiles` failure to a status, without leaking the file's contents. */
function failure(error, path, ctx) {
  const code = typeof error === 'object' && error !== null ? error.code : undefined;
  if (code === 'workspace-file/not-found') return text(404, 'The file does not exist.');
  if (code === 'workspace-file/not-regular-file' || code === 'gateway/bad-request') {
    return text(400, 'The named path is not a readable file.');
  }
  if (code === 'workspace-file/too-large') return text(416, 'The requested window exceeds the read cap.');
  try {
    ctx.logger?.warn?.('[file-agentero] media route failed for %s: %s', path, String(error?.message ?? error));
  } catch {
    // A broken logger must not turn a failure into a different failure.
  }
  return text(500, 'The media file is unavailable.');
}

/** Whether a backend read failed because the requested window was over its cap. */
function isWindowTooLarge(error) {
  return typeof error === 'object' && error !== null && error.code === 'workspace-file/too-large';
}

/**
 * Stream `length` bytes from `start` in bounded backend reads.
 *
 * `pull` reads only when the consumer asks, so backpressure reaches the
 * filesystem and a seek that abandons the response stops reading immediately
 * (`signal` aborts with the request).
 *
 * @param ctx - Host context carrying `workspaceFiles`.
 * @param scope - the Session's workspace scope.
 * @param path - workspace path to read.
 * @param start - first byte to send.
 * @param length - number of bytes to send; the file may end earlier.
 * @param signal - the request's abort signal.
 * @param windowBytes - preferred backend read size; halved when a backend caps lower.
 * @returns the response body.
 */
function streamBody(ctx, scope, path, start, length, signal, windowBytes) {
  let offset = start;
  let remaining = length;
  let window = Math.max(MIN_WINDOW_BYTES, Math.min(windowBytes, DEFAULT_WINDOW_BYTES));
  return new ReadableStream({
    async pull(controller) {
      try {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        let data;
        let want = 0;
        for (;;) {
          want = Math.min(window, remaining);
          if (want <= 0) {
            controller.close();
            return;
          }
          try {
            ({ data } = await ctx.workspaceFiles.readBytes(scope, path, { range: { offset, length: want } }, signal));
            break;
          } catch (error) {
            if (isWindowTooLarge(error) && want > MIN_WINDOW_BYTES) {
              window = Math.max(MIN_WINDOW_BYTES, Math.floor(want / 2));
              continue;
            }
            throw error;
          }
        }
        if (data === undefined || data.byteLength === 0) {
          controller.close();
          return;
        }
        const view = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
          ? data
          : new Uint8Array(data);
        controller.enqueue(view);
        offset += view.byteLength;
        remaining -= view.byteLength;
        // A short read means the file ended inside the window; nothing is left to send.
        if (view.byteLength < want) controller.close();
      } catch (error) {
        if (signal?.aborted === true) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
  });
}

/**
 * Serve one byte-range response for a media file.
 * @param ctx - Host context carrying `workspaceFiles` and `sessions`.
 * @param request - the Fetch request inside the browser-auth fence.
 * @param windowBytes - preferred backend read size.
 * @returns the streamed response, or an explained refusal.
 */
async function handleStream(ctx, request, windowBytes) {
  const params = coordinates(request);
  if (params instanceof Response) return params;
  if (!isMediaPath(params.path)) return text(415, 'This suffix is not served by the media preview.');
  const scope = scopeOf(ctx, params.sessionId);
  if (scope === undefined) return text(404, 'The Session is not available.');
  let stat;
  try {
    stat = await ctx.workspaceFiles.stat(scope, params.path, request.signal);
  } catch (error) {
    if (request.signal.aborted) return text(499, 'The client cancelled the request.');
    return failure(error, params.path, ctx);
  }
  const size = typeof stat.bytes === 'number' && stat.bytes >= 0 ? stat.bytes : 0;
  const type = mediaTypeOf(params.path);
  const common = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...common, 'content-length': String(size) } });
  }
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    return text(416, 'The byte range is not satisfiable.', { 'content-range': `bytes */${size}` });
  }
  if (range !== null && range.length === 0) {
    return text(416, 'The byte range is not satisfiable.', { 'content-range': `bytes */${size}` });
  }
  if (size === 0) {
    return new Response(null, { status: 200, headers: { ...common, 'content-length': '0' } });
  }
  const start = range === null ? 0 : range.offset;
  let length = range === null ? size : range.length;
  // A complete read of a huge file is answered as a bounded first window rather
  // than truncated: the browser asks for the rest with another Range request.
  const partial = range !== null || length > MAX_RANGE_BYTES;
  length = Math.min(length, MAX_RANGE_BYTES);
  const headers = { ...common, 'content-length': String(length) };
  if (partial) headers['content-range'] = `bytes ${start}-${start + length - 1}/${size}`;
  return new Response(streamBody(ctx, scope, params.path, start, length, request.signal, windowBytes), {
    status: partial ? 206 : 200,
    headers,
  });
}

/**
 * Report size, version and media type so the renderer can show a metadata line
 * and tell the preview which file version it is displaying.
 * @param ctx - Host context carrying `workspaceFiles` and `sessions`.
 * @param request - the Fetch request inside the browser-auth fence.
 * @returns JSON metadata, or an explained refusal.
 */
async function handleStat(ctx, request) {
  const params = coordinates(request);
  if (params instanceof Response) return params;
  if (!isMediaPath(params.path)) return text(415, 'This suffix is not served by the media preview.');
  const scope = scopeOf(ctx, params.sessionId);
  if (scope === undefined) return text(404, 'The Session is not available.');
  try {
    const stat = await ctx.workspaceFiles.stat(scope, params.path, request.signal);
    return Response.json(
      {
        size: typeof stat.bytes === 'number' ? stat.bytes : null,
        version: stat.version,
        type: mediaTypeOf(params.path),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (request.signal.aborted) return text(499, 'The client cancelled the request.');
    return failure(error, params.path, ctx);
  }
}

/**
 * Build the two route handlers for the plugin's Host context.
 * @param ctx - Host context carrying `connection`, `workspaceFiles`, `sessions`
 *   and `sandboxPolicy`; the caller injects exactly these.
 * @param options - optional window size override, used by tests.
 * @returns the Fetch handlers to register on `ctx.connection.fetch`.
 */
export function createMediaRoutes(ctx, options = {}) {
  const requested = Number(options.windowBytes);
  const windowBytes = Number.isFinite(requested) && requested >= MIN_WINDOW_BYTES
    ? Math.floor(requested)
    : DEFAULT_WINDOW_BYTES;
  return {
    stream: (request) => handleStream(ctx, request, windowBytes),
    stat: (request) => handleStat(ctx, request),
  };
}
