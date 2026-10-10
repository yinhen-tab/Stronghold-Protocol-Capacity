import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createAssetCacheHandler } from '../server/http/assetCache.js';
import { createRequestHandler } from '../server/http/routes.js';
import { CacheDownloadLimiter, assetCacheLimitOptions } from '../server/http/cacheLimiter.js';

const log = { warn() {}, error() {}, debug() {} };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run, { limits, trustProxy = false, sizes = [32_000, 32_000], failFirstBuild = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-cache-http-'));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true });
  const files = sizes.map((bytes, i) => ({ url: `/assets/test-${i}.png`, bytes,
    sha256: sha256(Buffer.alloc(bytes, i + 1)), type: 'image/png', aliases: [] }));
  for (let i = 0; i < files.length; i++) await fs.writeFile(path.join(publicDir, files[i].url), Buffer.alloc(files[i].bytes, i + 1));
  const catalog = { schema: 1, version: sha256(JSON.stringify(files)), app: 'test', files,
    totalFiles: files.length, totalBytes: sizes.reduce((sum, value) => sum + value, 0), complete: true, missing: [] };
  let builds = 0;
  const assetCache = createAssetCacheHandler({ publicDir, dataDir: root, log, limits, trustProxy,
    buildCatalog: async () => { builds++; if (failFirstBuild && builds === 1) throw new Error('test setup not ready'); return catalog; } });
  const server = http.createServer(createRequestHandler({ assetCache, log,
    serveStatic: async (req, res) => { res.writeHead(200, { 'Content-Length': 4 }); res.end('game'); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run({ root, publicDir, files, catalog, server, assetCache, builds: () => builds }); }
  finally {
    assetCache.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'cleanup remains in the temporary directory');
    assert.ok(path.basename(root).startsWith('sp-cache-http-'), 'cleanup targets only this test fixture');
    await fs.rm(root, { recursive: true, force: true });
  }
}

function request(server, url, { method = 'GET', headers = {}, onResponse, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers }, (res) => {
      const chunks = []; const startedAt = performance.now();
      onResponse?.(res, req);
      res.on('data', (chunk) => { chunks.push(chunk); onChunk?.(chunk, req); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        elapsed: performance.now() - startedAt }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

const downloadURL = (entry) => `/api/asset-cache/file?url=${encodeURIComponent(entry.url)}&hash=${entry.sha256}`;
const errorOf = (res) => JSON.parse(res.body.toString()).error;

test('pre-cache status/catalog share one snapshot; gzip, conditional GET and HEAD preserve metadata', async () => {
  await fixture(async ({ server, catalog, builds }) => {
    const [status, index] = await Promise.all([request(server, '/api/asset-cache/status'), request(server, '/api/asset-cache/catalog')]);
    const report = JSON.parse(status.body);
    assert.equal(report.totalBytes, catalog.totalBytes); assert.equal(report.totalFiles, 2);
    assert.equal(report.policy.totalBps, 1_000_000); assert.equal(report.policy.clientBps, 500_000);
    assert.equal(report.policy.activeDownloads, 0); assert.equal(builds(), 1);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(index.body), catalog); assert.equal(index.headers['cache-control'], 'no-cache');
    const gz = await request(server, '/api/asset-cache/catalog', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip'); assert.deepEqual(JSON.parse(gunzipSync(gz.body)), catalog);
    const hit = await request(server, '/api/asset-cache/catalog', { headers: { 'If-None-Match': index.headers.etag } });
    assert.equal(hit.status, 304); assert.equal(hit.body.length, 0);
    const head = await request(server, '/api/asset-cache/catalog', { method: 'HEAD' });
    assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], index.headers['content-length']);
    assert.equal(builds(), 1);
  });
});

test('catalog HTTP validators change for completeness metadata even when asset content is unchanged', async () => {
  await fixture(async ({ server, catalog, publicDir, root, assetCache }) => {
    const before = await request(server, '/api/asset-cache/catalog');
    const next = { ...catalog, complete: false, missing: [{ url: '/assets/missing.png', reason: 'missing file' }] };
    assetCache.close();
    const replacement = createAssetCacheHandler({ publicDir, dataDir: root, log, buildCatalog: async () => next });
    server.removeAllListeners('request');
    server.on('request', createRequestHandler({ assetCache: replacement, log, serveStatic: async () => {} }));
    try {
      const after = await request(server, '/api/asset-cache/catalog', { headers: { 'If-None-Match': before.headers.etag } });
      assert.equal(after.status, 200); assert.notEqual(after.headers.etag, before.headers.etag);
      assert.equal(JSON.parse(after.body).version, catalog.version);
      assert.equal(JSON.parse(after.body).complete, false);
    } finally { replacement.close(); }
  });
});

test('pre-cache downloads only exact catalog paths/hashes, full uncompressed responses and safe GET/HEAD', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const response = await request(server, downloadURL(files[0]), { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-encoding'], undefined); assert.equal(response.headers['x-asset-sha256'], files[0].sha256);
    assert.equal(response.headers['x-accel-buffering'], 'no'); assert.equal(sha256(response.body), files[0].sha256);
    const head = await request(server, downloadURL(files[0]), { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(assetCache.policy().activeDownloads, 0);
    const stale = await request(server, downloadURL({ ...files[0], sha256: '0'.repeat(64) }));
    assert.equal(stale.status, 409); assert.equal(errorOf(stale), 'ASSET_CACHE_STALE_HASH');
    const unknown = await request(server, downloadURL({ ...files[0], url: '/assets/../secret.png' }));
    assert.equal(unknown.status, 404); assert.equal(errorOf(unknown), 'ASSET_CACHE_FILE_NOT_FOUND');
    const ranged = await request(server, downloadURL(files[0]), { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 400); assert.equal(errorOf(ranged), 'ASSET_CACHE_RANGE_UNSUPPORTED');
    assert.equal((await request(server, downloadURL(files[0]) + '&hash=' + files[0].sha256)).status, 400);
    assert.equal((await request(server, '/api/asset-cache/not-found')).status, 404);
    assert.equal((await request(server, '/api/asset-cache/status', { method: 'POST' })).status, 405);
  }, { limits: { totalBps: 2_000_000, clientBps: 1_000_000 } });
});

test('changed and missing files never masquerade as the catalog hash', async () => {
  await fixture(async ({ server, publicDir, files }) => {
    await request(server, '/api/asset-cache/catalog');
    const file = path.join(publicDir, files[0].url);
    await fs.writeFile(file, Buffer.alloc(files[0].bytes, 99));
    const changed = await request(server, downloadURL(files[0]));
    assert.equal(changed.status, 409); assert.equal(errorOf(changed), 'ASSET_CACHE_SOURCE_CHANGED');
    await fs.unlink(file);
    assert.equal((await request(server, downloadURL(files[0]))).status, 409);
  });
});

test('a file replaced by a symlink after catalog construction is refused', async (t) => {
  await fixture(async ({ server, publicDir, files }) => {
    await request(server, '/api/asset-cache/catalog');
    const file = path.join(publicDir, files[0].url);
    await fs.unlink(file);
    try { await fs.symlink(path.join(publicDir, files[1].url), file, 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip(`symlink creation unavailable (${error.code})`); return;
    }
    const result = await request(server, downloadURL(files[0]));
    assert.equal(result.status, 409); assert.equal(errorOf(result), 'ASSET_CACHE_SOURCE_CHANGED');
  });
});

test('an unavailable catalog returns a retryable failure and does not poison subsequent requests', async () => {
  await fixture(async ({ server, builds }) => {
    const unavailable = await request(server, '/api/asset-cache/status');
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers['retry-after'], '5');
    assert.equal(errorOf(unavailable), 'ASSET_CACHE_CATALOG_UNAVAILABLE');
    assert.equal((await request(server, '/api/asset-cache/status')).status, 200);
    assert.equal(builds(), 2);
  }, { failFirstBuild: true });
});

test('online disable and full slots are explicit; HEAD and game assets do not consume download slots', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const disabled = await request(server, downloadURL(files[0]));
    assert.equal(disabled.status, 503); assert.equal(errorOf(disabled), 'ASSET_CACHE_ONLINE_DISABLED');
    assert.equal((await request(server, '/assets/test-0.png')).status, 200);
    assert.equal((await request(server, downloadURL(files[0]), { method: 'HEAD' })).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 0);
  }, { limits: { totalBps: 0 } });
  await fixture(async ({ server, files, assetCache }) => {
    let begin;
    const begun = new Promise((resolve) => { begin = resolve; });
    const slow = request(server, downloadURL(files[0]), { onResponse: begin });
    await begun;
    const busy = await request(server, downloadURL(files[1]));
    assert.equal(busy.status, 429); assert.equal(busy.headers['retry-after'], '3');
    const before = performance.now();
    assert.equal((await request(server, '/assets/normal-game.png')).body.toString(), 'game');
    assert.ok(performance.now() - before < 300, 'ordinary gameplay HTTP is not queued behind pre-cache downloads');
    assert.equal((await request(server, downloadURL(files[1]), { method: 'HEAD' })).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 1);
    assert.equal((await slow).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 0);
  }, { limits: { totalBps: 120_000, clientBps: 120_000, maxDownloads: 1 } });
});

test('two clients dynamically share the one aggregate byte budget fairly over real HTTP', async () => {
  await fixture(async ({ server, files }) => {
    const started = performance.now(); const received = [0, 0]; const first = [null, null];
    const responses = await Promise.all(files.map((entry, i) => request(server, downloadURL(entry), {
      headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
      onChunk: (chunk) => { received[i] += chunk.length; if (first[i] == null) first[i] = performance.now() - started; },
    })));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 850, `aggregate 160000 bytes at 160000 B/s cannot finish in ${elapsed} ms`);
    assert.ok(elapsed < 3000, `scheduler kept available bandwidth unused (${elapsed} ms)`);
    assert.ok(Math.abs(responses[0].elapsed - responses[1].elapsed) < 300, 'round-robin does not starve either client');
    assert.ok(first.every((time) => time != null && time < 250));
    assert.deepEqual(received, [80_000, 80_000]);
    responses.forEach((res, i) => assert.equal(sha256(res.body), files[i].sha256));
  }, { trustProxy: true, sizes: [80_000, 80_000], limits: { totalBps: 160_000, clientBps: 160_000 } });
});

test('multiple responses from one client share its ceiling; cancellation releases its slot immediately', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const started = performance.now();
    await Promise.all(files.map((entry) => request(server, downloadURL(entry))));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 850, `two sockets bypassed a shared client ceiling (${elapsed} ms)`);
    assert.ok(elapsed < 3000);
    let canceled = false;
    await assert.rejects(request(server, downloadURL(files[0]), { onChunk: (_chunk, req) => {
      if (!canceled) { canceled = true; req.destroy(new Error('test canceled')); }
    } }), /test canceled|aborted/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(assetCache.policy().activeDownloads, 0);
    assert.equal((await request(server, downloadURL(files[1]))).status, 200);
  }, { sizes: [40_000, 40_000], limits: { totalBps: 1_000_000, clientBps: 80_000 } });
});

test('rate configuration uses byte units and fails closed on invalid values', () => {
  assert.equal(assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '0' }).totalBps, 0);
  assert.equal(assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '1000000' }).totalBps, 1_000_000);
  assert.throws(() => assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '-1' }), RangeError);
  assert.throws(() => assetCacheLimitOptions({ clientBps: 0 }), RangeError);
  assert.throws(() => new CacheDownloadLimiter({ maxDownloads: 0 }), RangeError);
});

test('very low positive rates still accumulate a one-byte token', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1, clientBps: 1 });
  const response = new EventEmitter(); response.write = () => true; response.end = () => { response.writableEnded = true; response.emit('close'); };
  const handle = { read: async (buffer, _offset, length) => { buffer.fill(1); return { bytesRead: length }; } };
  const lease = limiter.acquire('low-rate'); lease.stream(handle, response, 1);
  // Advance the elapsed refill time without adding a wall-clock one-second delay.
  limiter.updatedAt -= 1200; limiter.clients.get('low-rate').updatedAt -= 1200;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(response.writableEnded, true);
  } finally { limiter.close(); }
});

test('backpressure bounds the buffered chunk; drain resumes and shutdown cancels waiting responses', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1_000_000, clientBps: 1_000_000 });
  const response = new EventEmitter();
  const lengths = [];
  response.write = (buffer) => { lengths.push(buffer.length); return false; };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  let readCalls = 0;
  const handle = { read: async (buffer, _offset, length) => { readCalls++; buffer.fill(1); return { bytesRead: length }; } };
  const lease = limiter.acquire('test-client');
  const streaming = lease.stream(handle, response, 100_000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(readCalls, 1, 'no further file chunks are read while the response is backpressured');
  assert.ok(lengths[0] <= 8192, 'each response holds at most one quantum in application memory');
  response.emit('drain');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(readCalls, 2);
  limiter.close(); await streaming;
  assert.equal(limiter.policy().activeDownloads, 0); assert.equal(response.destroyed, true);
  assert.equal(limiter.acquire('late-client'), null);
});
