/**
 * Host half of the workspace file quicklook bundle.
 *
 * Two capabilities live here:
 *
 * - A one-shot translation endpoint used by the selection toolbar. It reuses the
 *   profile's default model, translates between Simplified Chinese and English
 *   only, and never creates a Session message.
 * - The media stream: two authenticated Fetch routes that serve one workspace
 *   video or audio file to the document preview, so the right Sidebar plays it
 *   instead of handing it to another application.
 */
import { createUpdater } from './update.js';
import { createMediaRoutes, MEDIA_STAT_PATH, MEDIA_STREAM_PATH } from './media.js';

export const inject = ['webServer'];

/** Same-origin endpoint the browser toolbar posts a selection to. */
const ROUTE = '/file-agentero/translate';
/** Version status: GET reads it, POST starts the reinstall. */
const UPDATE_API = '/file-agentero/update';
/** Published versions plus the packaged changelog, for the update page. */
const VERSIONS_API = '/file-agentero/versions';
/** A selection larger than this is refused instead of spending a huge call. */
const MAX_TEXT_LENGTH = 8_000;
/** Translation is a short interactive wait, not a background job. */
const TIMEOUT_MS = 120_000;
/** The only body this route accepts is a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024;

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN = /[A-Za-z]/g;

/** Chinese-dominant selections go to English; everything else goes to Chinese. */
function translationTarget(text) {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  return cjk > 0 && cjk >= latin * 0.2 ? 'en' : 'zh-CN';
}

/** True when the request names this machine's loopback. */
function loopbackHost(header) {
  if (typeof header !== 'string' || header.trim() === '') return false;
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 && value.slice(1, end) === '::1';
  }
  const colon = value.lastIndexOf(':');
  const name = colon === -1 ? value : value.slice(0, colon);
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function messageOf(error) {
  if (error instanceof Error && error.message.trim() !== '') return error.message.trim();
  return '翻译失败，请重试。';
}

/** Read one `?name=1` style flag from a request URL. */
function queryFlag(req, name) {
  try {
    return new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get(name) === '1';
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Read one bounded JSON body; `undefined` means malformed or too large. */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        finish(undefined);
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
}

/**
 * Translate one selection through the profile's default model.
 * No Session or tool context is attached: this is a single throwaway call.
 */
async function translate(ctx, text, target, signal) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection();
  const provider = typeof selection?.provider === 'string' ? selection.provider : '';
  const model = typeof selection?.model === 'string' ? selection.model : '';
  if (provider === '' || model === '') {
    throw new Error('未配置默认模型，请先在「设置 → 模型」里选择默认模型。');
  }
  const llm = ctx.get('llm');
  if (llm === undefined || llm === null) {
    throw new Error('模型服务不可用。');
  }

  const language = target === 'en' ? 'English' : 'Simplified Chinese';
  const system = `You are a precise translator. Translate the user's text into ${language}. `
    + 'Keep Markdown formatting, code, formulas, numbers, and line breaks intact. '
    + 'Return only the translation: no explanation, no quotes, no preamble.';

  const call = await llm.prepareCall(
    { provider, model, temperature: 0.2, maxTokens: 8192 },
    signal,
    (controls, info) => {
      // Effort ids belong to the adapter; its catalog orders them least to
      // greatest. Translation is a light task, so take the cheapest effort.
      const effort = info.reasoning?.efforts?.[0]?.id;
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
    },
  );
  const blocks = new Map();
  let complete = false;
  for await (const chunk of call.stream({
    ...call.config,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    // opencode-go routes by conversation; a throwaway translation still needs
    // a stable non-empty id so the adapter can set its required header.
    sessionId: 'file-agentero-translate',
    signal,
  })) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.index === 'number') {
      blocks.set(chunk.index, chunk.block.text);
    }
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') {
        const detail = chunk.reason?.failure?.message;
        throw new Error(
          typeof detail === 'string' && detail.trim() !== ''
            ? detail
            : '翻译未完成，请缩短选区后重试。',
        );
      }
      complete = true;
    }
  }
  signal.throwIfAborted();
  if (!complete) throw new Error('翻译未完成，请重试。');

  const result = [...blocks]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .join('\n')
    .trim();
  if (result === '') throw new Error('模型没有返回译文，请重试。');
  return result;
}

/**
 * Register the translation route and own its disposable lifetime.
 * @param ctx - Host plugin context carrying the web server.
 */
export function apply(ctx) {
  const updater = createUpdater({
    ctx,
    warn: (message) => {
      try {
        ctx.logger?.warn?.(message);
      } catch {
        // A broken logger must not break an update check.
      }
    },
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }
      if (!loopbackHost(req.headers.host)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      // A custom header forces a CORS preflight, so a random web page cannot
      // spend the user's model tokens with a simple cross-origin POST.
      if (req.headers['x-file-agentero'] !== '1') {
        res.statusCode = 403;
        res.end();
        return;
      }

      const body = await readJson(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid body' });
        return;
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '' || text.length > MAX_TEXT_LENGTH) {
        sendJson(res, 400, { error: 'invalid body' });
        return;
      }

      const target = translationTarget(text);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
        const translation = await translate(ctx, text, target, signal);
        sendJson(res, 200, { translation, target });
      } catch (error) {
        sendJson(res, 502, { error: messageOf(error) });
      } finally {
        res.off('close', abort);
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPDATE_API,
    handler: async (req, res) => {
      if (!loopbackHost(req.headers.host)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (req.method === 'POST' && req.headers['x-file-agentero'] !== '1') {
        res.statusCode = 403;
        res.end();
        return;
      }
      const fresh = queryFlag(req, 'fresh');
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, await updater.check({ fresh }));
          return;
        }
        if (req.method === 'POST') {
          sendJson(res, 200, updater.start());
          return;
        }
        res.statusCode = 405;
        res.setHeader('allow', 'GET, POST');
        res.end();
      } catch (error) {
        sendJson(res, 200, { success: false, error: String(error?.message ?? error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VERSIONS_API,
    handler: async (req, res) => {
      if (!loopbackHost(req.headers.host)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      const fresh = queryFlag(req, 'fresh');
      try {
        sendJson(res, 200, { success: true, ...(await updater.versions({ fresh })) });
      } catch (error) {
        sendJson(res, 200, { success: false, error: String(error?.message ?? error) });
      }
    },
  }));

  // Media preview. These routes register on Connection's authenticated Fetch
  // fence (the same cookie gate as every `/api` route), because a `<video>`
  // element cannot send the custom header the loopback routes above require.
  // They are optional on purpose: a composition without the web connection
  // keeps the translation and update endpoints instead of failing to load.
  ctx.inject(['connection', 'workspaceFiles', 'sessions', 'sandboxPolicy'], (mediaCtx) => {
    const routes = createMediaRoutes(mediaCtx);
    const register = (path, methods, fetch, label) => mediaCtx.effect(() => {
      const pending = mediaCtx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch });
      return () => {
        void Promise.resolve(pending).then((dispose) => {
          if (typeof dispose === 'function') dispose();
        });
      };
    }, label);
    register(MEDIA_STREAM_PATH, ['GET', 'HEAD'], routes.stream, 'file-agentero: media stream route');
    register(MEDIA_STAT_PATH, ['GET'], routes.stat, 'file-agentero: media stat route');
  });
}
