// Targeted browser checks: no game simulation or full 14-round run is involved.
// SP_E2E=1 node --test test/asset-cache.browser.test.js (CHROME_PATH can override Edge).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const enabled = process.env.SP_E2E === '1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PAGE = `<!doctype html><title>Asset cache fixture</title><link rel="icon" href="data:,">
<script type="module">
import { createAssetCacheManager } from '/js/assetCache.js';
const manager = createAssetCacheManager();
window.cacheFixture = { manager, ready: manager.initialize(), state: () => manager.getState() };
</script>`;

async function zipBytes(entries, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of entries) await writer.add(name, new Uint8ArrayReader(Buffer.from(bytes)),
    { useWebWorkers: false, ...options });
  return Buffer.from(await writer.close());
}

async function fixture(run) {
  const contents = new Map([
    ['/assets/a.png', Buffer.from('image-one')],
    ['/assets/audio/中 文.mp3', Buffer.from('1234567890')],
    ['/assets/local/spine/token/foo.skel', Buffer.from('local-token')],
  ]);
  let version = 1, slow = false, failCatalog = false;
  const downloads = [], ordinary = [], closed = [];
  const catalog = () => {
    const files = [...contents].map(([url, body]) => ({ url, bytes: body.length, sha256: hash(body),
      type: url.endsWith('.png') ? 'image/png' : url.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream',
      aliases: url.includes('/audio/') ? ['/media/中 文'] : [] }));
    return { schema: 1, version: hash(String(version)), app: 'fixture', files, totalFiles: files.length,
      totalBytes: files.reduce((sum, item) => sum + item.bytes, 0), complete: true, missing: [] };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
    if (url.pathname === '/api/asset-cache/catalog') {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-cache');
      res.end(JSON.stringify(failCatalog ? {} : catalog())); return;
    }
    if (url.pathname === '/api/asset-cache/status') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ policy: { enabled: true, totalBps: 1000000, clientBps: 500000 } })); return;
    }
    if (url.pathname === '/api/asset-cache/file') {
      const target = url.searchParams.get('url'); const bytes = contents.get(target);
      downloads.push(target);
      if (!bytes || hash(bytes) !== url.searchParams.get('hash')) { res.writeHead(409); res.end(); return; }
      res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': catalog().files.find((f) => f.url === target).type, 'Cache-Control': 'no-store' });
      if (slow) {
        res.write(bytes.subarray(0, 1));
        const timer = setTimeout(() => res.end(bytes.subarray(1)), 5000);
        res.on('close', () => { closed.push(target); clearTimeout(timer); });
      } else res.end(bytes);
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    if (contents.has(pathname) || pathname === '/media/中 文') {
      ordinary.push(pathname); res.writeHead(200, { 'Content-Type': pathname.includes('media') ? 'audio/mpeg' : 'application/octet-stream' });
      res.end(contents.get(pathname) || contents.get('/assets/audio/中 文.mp3')); return;
    }
    if (pathname === '/api/private' || pathname === '/data/fixture.json') { ordinary.push(pathname); res.end('always-network'); return; }
    const files = new Map([
      ['/asset-cache-sw.js', 'public/asset-cache-sw.js'], ['/js/assetCache.js', 'public/js/assetCache.js'],
      ['/js/asset-cache-worker.js', 'public/js/asset-cache-worker.js'], ['/shared/assetCache.js', 'shared/assetCache.js'],
      ['/vendor/zip-native.min.js', 'public/vendor/zip-native.min.js'],
    ]);
    if (!files.has(pathname)) { res.writeHead(404); res.end('missing'); return; }
    try { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }); res.end(await fs.readFile(path.join(ROOT, files.get(pathname)))); }
    catch { res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
  const problems = [];
  const page = await browser.newPage();
  page.on('pageerror', (error) => problems.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.cacheFixture);
    await page.evaluate(() => window.cacheFixture.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await run({ page, browser, url, contents, downloads, ordinary, problems, closed, catalog,
      setSlow: (value) => { slow = value; }, setFail: (value) => { failCatalog = value; },
      upgrade: () => { version++; contents.set('/assets/a.png', Buffer.from('image-two')); } });
  } finally {
    await browser.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

const opts = { skip: enabled ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000 };
const state = (page) => page.evaluate(() => window.cacheFixture.state());
const download = (page) => page.evaluate(() => window.cacheFixture.manager.downloadMissing());
async function importBytes(page, bytes) {
  return page.evaluate((data) => window.cacheFixture.manager.importZip(new File([Uint8Array.from(data)], 'assets.zip')),
    [...bytes]);
}

test('Edge caches full assets, audio aliases/ranges, reload persistence and only changed files after upgrade', opts, async () => {
  await fixture(async ({ page, contents, downloads, ordinary, upgrade, problems }) => {
    assert.equal((await state(page)).supported, true); assert.equal((await state(page)).readyFiles, 0);
    await download(page);
    assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 3);
    const bodies = await page.evaluate(async () => {
      const image = await fetch('/assets/a.png?version=something', { cache: 'no-store' });
      const sound = await fetch('/media/%E4%B8%AD%20%E6%96%87', { headers: { Range: 'bytes=2-5' }, cache: 'no-store' });
      const wrong = await fetch('/media/%E4%B8%AD%20%E6%96%87', { headers: { Range: 'bytes=30-' } });
      await fetch('/api/private'); await fetch('/data/fixture.json');
      return { image: await image.text(), sound: await sound.text(), status: sound.status,
        type: sound.headers.get('content-type'), range: sound.headers.get('content-range'), wrong: wrong.status };
    });
    assert.deepEqual(bodies, { image: 'image-one', sound: '3456', status: 206, type: 'audio/mpeg', range: 'bytes 2-5/10', wrong: 416 });
    assert.deepEqual(ordinary, ['/api/private', '/data/fixture.json']);
    await page.reload(); await page.waitForFunction(() => window.cacheFixture);
    await page.evaluate(() => window.cacheFixture.ready);
    assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 3);
    upgrade();
    await page.evaluate(() => window.cacheFixture.manager.scan());
    assert.equal((await state(page)).missingFiles, 1);
    await download(page); assert.equal(downloads.length, 4);
    assert.equal(downloads.at(-1), '/assets/a.png');
    assert.equal(await page.evaluate(async () => (await fetch('/assets/a.png')).text()), contents.get('/assets/a.png').toString());
    assert.deepEqual(problems, []);
  });
});

test('Edge imports partial/old ZIP locally, refuses traversal, and deep verification repairs corrupt cache', opts, async () => {
  await fixture(async ({ page, contents, downloads, ordinary, problems }) => {
    const entries = [...contents].map(([url, bytes]) => [url.slice(1), bytes]);
    const partial = await zipBytes([entries[0], [entries[1][0], 'wrong-data'], ['assets/obsolete.png', 'old'], ['manifest.json', '{}']]);
    await importBytes(page, partial);
    assert.equal((await state(page)).readyFiles, 1); assert.equal((await state(page)).importStats.invalid, 1);
    assert.equal(downloads.length, 0); assert.deepEqual(ordinary, []);
    const full = await zipBytes(entries);
    await importBytes(page, full);
    assert.equal((await state(page)).readyFiles, 3); assert.equal((await state(page)).importStats.reused, 1);
    assert.equal(downloads.length, 0);
    const result = await importBytes(page, await zipBytes([['assets/../attack.png', 'x']])).catch((error) => error.message);
    assert.match(result, /ASSET_CACHE_ZIP_(?:UNSAFE|INVALID)/);
    await page.evaluate(async () => {
      const cache = await caches.open('sp-asset-cache-v1');
      const key = (await cache.keys())[0]; const response = await cache.match(key);
      await cache.put(key, new Response('corrupted', { headers: response.headers }));
      await window.cacheFixture.manager.scan({ deep: true });
    });
    assert.equal((await state(page)).readyFiles, 2); assert.equal((await state(page)).scanStats.invalid, 1);
    await download(page); assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 1);
    assert.deepEqual(problems, []);
  });
});

test('Edge cross-tab playing guard pauses online filling, preserves files, releases locks and allows retries', opts, async () => {
  await fixture(async ({ page, browser, url, downloads, setSlow, closed, problems }) => {
    const second = await browser.newPage(); await second.goto(url);
    await second.waitForFunction(() => window.cacheFixture); await second.evaluate(() => window.cacheFixture.ready);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(true));
    assert.match(await download(page).catch((error) => error.message), /ASSET_CACHE_PLAYING/);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(false));
    setSlow(true);
    const pending = download(page);
    await page.waitForFunction(() => window.cacheFixture.state().phase === 'downloading');
    assert.match(await download(second).catch((error) => error.message), /ASSET_CACHE_BUSY/);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(true));
    await pending;
    assert.equal((await state(page)).phase, 'paused');
    assert.equal((await state(page)).readyFiles, 0);
    await second.close();
    setSlow(false);
    await download(page);
    assert.equal((await state(page)).readyFiles, 3);
    assert.ok(downloads.length >= 3); assert.ok(closed.length <= 1);
    assert.deepEqual(problems, []);
  });
});
