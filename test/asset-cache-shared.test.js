import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAssetPath, safeAssetZipName, decodedAssetPath, parseAssetRange, validateAssetCatalog,
  assetContentKey, isVerifiedAssetResponse, validatedCacheHeaders, sha256Hex } from '../shared/assetCache.js';
import { createAssetCacheManager } from '../public/js/assetCache.js';

const entry = { url: '/assets/audio/中 文.mp3', bytes: 3,
  sha256: 'a'.repeat(64), type: 'audio/mpeg', aliases: ['/media/中 文'] };
const fixture = () => ({ schema: 1, version: 'b'.repeat(64), files: [{ ...entry, aliases: [...entry.aliases] }],
  totalFiles: 1, totalBytes: 3, complete: true, missing: [] });

test('catalog accepts decoded Unicode art and media aliases, rejects path/private/code collisions', () => {
  assert.equal(validateAssetCatalog(fixture()).totalFiles, 1);
  for (const value of ['/data/x.json', '/js/x.js', '/api/announcement-assets/x.png', '/assets/../x.png',
    '/assets/%2e.png', '/assets/x.png?q=1', '/assets/a\\b.png', 'https://cdn.test/x.png', '/assets/x.js']) {
    assert.equal(safeAssetPath(value), false, value);
  }
  for (const field of ['bytes', 'sha256', 'type', 'aliases']) {
    const bad = fixture(); bad.files[0][field] = null;
    assert.throws(() => validateAssetCatalog(bad), /BAD_CATALOG/);
  }
  const collision = fixture(); collision.files.push({ ...entry }); collision.totalFiles++;
  assert.throws(() => validateAssetCatalog(collision), /BAD_CATALOG/);
  const wrongTotal = fixture(); wrongTotal.totalBytes++;
  assert.throws(() => validateAssetCatalog(wrongTotal), /BAD_CATALOG/);
});

test('request normalization keeps same-origin aliases/query variants, rejects encoded separators and APIs', () => {
  const origin = 'https://game.test';
  assert.equal(decodedAssetPath('/assets/audio/%E4%B8%AD%20%E6%96%87.mp3?v=one', origin), entry.url);
  assert.equal(decodedAssetPath('/media/%E4%B8%AD%20%E6%96%87?x=1', origin), entry.aliases[0]);
  for (const url of ['https://other.test/assets/x.png', '/assets/a%2fb.png', '/assets/%255c.png',
    '/api/asset-cache/file?url=/assets/x.png', '/assets/%zz.png']) assert.equal(decodedAssetPath(url, origin), null);
});

test('ZIP names retain Unicode/directory entries and reject hidden, executable path tricks and traversal', () => {
  for (const name of ['manifest.json', 'assets/', 'assets/模型.atlas', 'fonts/main.woff2']) assert.equal(safeAssetZipName(name), true);
  for (const name of ['', '/assets/a.png', 'assets/../x.png', 'assets/./x.png', 'assets/.x.png',
    'assets/a\\b.png', 'assets/x.png:stream', 'assets/x.png ', 'assets/x.png.', 'assets/a\u0000.png'])
    assert.equal(safeAssetZipName(name), false, name);
});

test('single byte range handling covers open/suffix/clamped and rejects invalid multipart requests', () => {
  assert.deepEqual(parseAssetRange('bytes=1-2', 5), { start: 1, end: 2 });
  assert.deepEqual(parseAssetRange('bytes=1-', 5), { start: 1, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=-2', 5), { start: 3, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=-20', 5), { start: 0, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=2-20', 5), { start: 2, end: 4 });
  for (const value of ['bytes=5-', 'bytes=2-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
    assert.equal(parseAssetRange(value, 5), null, value);
  }
});

test('verified content keys/response markers cannot mistake partial or mismatched data for full cache', async () => {
  assert.equal(assetContentKey(entry.sha256), '/__sp_asset_cache__/sha256/' + entry.sha256);
  assert.throws(() => assetContentKey('not a hash'), /BAD_HASH/);
  assert.equal(isVerifiedAssetResponse(new Response('abc', { headers: validatedCacheHeaders(entry) }), entry), true);
  assert.equal(isVerifiedAssetResponse(new Response('abc', { status: 206, headers: validatedCacheHeaders(entry) }), entry), false);
  assert.equal(isVerifiedAssetResponse(new Response('abc'), entry), false);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('manager imports under Node without DOM side effects; insecure contexts remain unsupported', async () => {
  const manager = createAssetCacheManager({ environment: {} });
  assert.equal(manager.getState().supported, false);
  assert.equal((await manager.initialize()).error, 'ASSET_CACHE_HTTPS_REQUIRED');
  await manager.setPlaying(true);
  assert.equal(manager.getState().playing, true);
  manager.destroy();
});
