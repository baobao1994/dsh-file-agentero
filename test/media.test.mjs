/**
 * Media route tests: Range grammar, response headers, windowed streaming.
 *
 * The fake Host context serves one real temporary file through the same
 * `workspaceFiles.stat/readBytes` shape the platform provides, so these tests
 * exercise the route rather than a mock of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_STAT_PATH,
  MEDIA_STREAM_PATH,
  createMediaRoutes,
  mediaTypeOf,
  parseRange,
} from '../media.js';

/** Deterministic test bytes: every byte's value is its own offset modulo 251. */
function payload(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

/**
 * A Host context whose workspaceFiles reads one file from disk.
 * @param file - absolute path, size and version the fake reports.
 * @param options - `missing` refuses every read; `maxWindow` refuses larger reads.
 */
function fakeContext(file, options = {}) {
  const sessions = new Map([['session-1', { header: { cwd: '/workspace' } }]]);
  return {
    sessions: { get: (id) => sessions.get(id) },
    sandboxPolicy: { workspaceRoot: '/workspace' },
    logger: { warn() {} },
    workspaceFiles: {
      async stat() {
        if (options.missing === true) {
          throw Object.assign(new Error('not found'), { code: 'workspace-file/not-found' });
        }
        return { absolutePath: file.path, version: file.version, bytes: file.size };
      },
      async readBytes(_scope, _path, readOptions, signal) {
        if (options.missing === true) {
          throw Object.assign(new Error('not found'), { code: 'workspace-file/not-found' });
        }
        const { offset = 0, length = file.size } = readOptions.range ?? {};
        if (options.maxWindow !== undefined && length > options.maxWindow) {
          throw Object.assign(new Error('too large'), { code: 'workspace-file/too-large' });
        }
        signal?.throwIfAborted();
        const data = readFileSync(file.path);
        return { data: data.subarray(offset, offset + length), offset, eof: offset + length >= data.length };
      },
    },
  };
}

/** One request against the stream route. */
function streamRequest(query, headers = {}, method = 'GET') {
  return new Request('http://127.0.0.1:1' + MEDIA_STREAM_PATH + '?' + query, { method, headers });
}

/** One temporary workspace file, removed when the test ends. */
function fixture(t, name, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'agentero-media-'));
  const path = join(directory, name);
  writeFileSync(path, bytes);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path, bytes, query: 'sessionId=session-1&path=' + encodeURIComponent(path) };
}

test('parseRange normalizes the forms browsers send', () => {
  assert.equal(parseRange(null, 100), null);
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('  ', 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { offset: 0, length: 10 });
  assert.deepEqual(parseRange('bytes=90-', 100), { offset: 90, length: 10 });
  assert.deepEqual(parseRange('bytes=-10', 100), { offset: 90, length: 10 });
  assert.deepEqual(parseRange('bytes=50-999', 100), { offset: 50, length: 50 });
  assert.deepEqual(parseRange('bytes=-500', 100), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=100-', 100), { offset: 100, length: 0 });
  assert.deepEqual(parseRange('bytes=200-', 100), { offset: 200, length: 0 });
  assert.deepEqual(parseRange('bytes=0-', 0), { offset: 0, length: 0 });
  assert.equal(parseRange('bytes=5-1', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-9', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
  assert.equal(parseRange('bytes=abc', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
});

test('mediaTypeOf claims video and audio, and refuses everything else', () => {
  assert.equal(mediaTypeOf('/w/render.mp4'), 'video/mp4');
  assert.equal(mediaTypeOf('/w/take.MOV'), 'video/quicktime');
  assert.equal(mediaTypeOf('/w/voice.mp3'), 'audio/mpeg');
  assert.equal(mediaTypeOf('/w/voice.m4a'), 'audio/mp4');
  assert.equal(mediaTypeOf('/w/screen.webm'), 'video/webm');
  assert.equal(mediaTypeOf('/w/notes.txt'), undefined);
  assert.equal(mediaTypeOf('/w/movie.mkv'), undefined);
  assert.equal(mediaTypeOf('/w/.mp4'), undefined);
});

test('the stream route serves exact bytes with and without a Range', async (t) => {
  const { path, bytes, query } = fixture(t, 'render.mp4', payload(200_000));
  const routes = createMediaRoutes(fakeContext({ path, size: bytes.length, version: 'v1' }), { windowBytes: 64 * 1024 });

  const full = await routes.stream(streamRequest(query));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

  const ranged = await routes.stream(streamRequest(query, { range: 'bytes=100-199' }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/200000');
  assert.equal(ranged.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(100, 200));

  const tail = await routes.stream(streamRequest(query, { range: 'bytes=-64' }));
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 64));

  const open = await routes.stream(streamRequest(query, { range: 'bytes=' + (bytes.length - 10) + '-' }));
  assert.equal(open.status, 206);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), bytes.subarray(bytes.length - 10));
});

test('the stream route answers HEAD with metadata and no body', async (t) => {
  const { path, bytes, query } = fixture(t, 'voice.mp3', payload(2048));
  const routes = createMediaRoutes(fakeContext({ path, size: bytes.length, version: 'v2' }));
  const response = await routes.stream(streamRequest(query, {}, 'HEAD'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('content-length'), '2048');
  assert.equal(await response.text(), '');
});

test('unsatisfiable and malformed ranges answer 416 with the file size', async (t) => {
  const { path, bytes, query } = fixture(t, 'clip.mp4', payload(1000));
  const routes = createMediaRoutes(fakeContext({ path, size: bytes.length, version: 'v1' }));

  for (const range of ['bytes=5000-', 'bytes=0-1,4-9', 'bytes=nope', 'bytes=9-2']) {
    const response = await routes.stream(streamRequest(query, { range }));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */1000', range);
  }
});

test('the stream route refuses unknown suffixes, missing coordinates and sessions', async (t) => {
  const text = fixture(t, 'notes.txt', Buffer.from('hello'));
  const routes = createMediaRoutes(fakeContext({ path: text.path, size: text.bytes.length, version: 'v1' }));
  assert.equal((await routes.stream(streamRequest(text.query))).status, 415);

  const media = fixture(t, 'clip.mp4', payload(64));
  const mediaRoutes = createMediaRoutes(fakeContext({ path: media.path, size: media.bytes.length, version: 'v1' }));
  assert.equal((await mediaRoutes.stream(streamRequest('sessionId=session-1'))).status, 400);
  assert.equal((await mediaRoutes.stream(streamRequest('path=' + encodeURIComponent(media.path)))).status, 400);
  assert.equal((await mediaRoutes.stream(streamRequest(media.query.replace('session-1', 'gone')))).status, 404);

  const missingPath = join(media.path, '..', 'gone.mp4');
  const missing = createMediaRoutes(fakeContext({ path: missingPath, size: 0, version: 'v1' }, { missing: true }));
  const response = await missing.stream(streamRequest('sessionId=session-1&path=' + encodeURIComponent(missingPath)));
  assert.equal(response.status, 404);
});

test('the stream route halves its window when the backend caps reads lower', async (t) => {
  const { path, bytes, query } = fixture(t, 'big.mp4', payload(300_000));
  const routes = createMediaRoutes(
    fakeContext({ path, size: bytes.length, version: 'v1' }, { maxWindow: 128 * 1024 }),
    { windowBytes: 256 * 1024 },
  );
  const response = await routes.stream(streamRequest(query));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('the stat route reports size, version and type', async (t) => {
  const { path, bytes, query } = fixture(t, 'take.wav', payload(512));
  const routes = createMediaRoutes(fakeContext({ path, size: bytes.length, version: 'v7' }));
  const response = await routes.stat(new Request('http://127.0.0.1:1' + MEDIA_STAT_PATH + '?' + query));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { size: 512, version: 'v7', type: 'audio/wav' });
});
