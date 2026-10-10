import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog, assetCacheURLProblem } from '../server/assetCacheCatalog.js';
import { validateAssetCatalog, catalogURLMap } from '../shared/assetCache.js';

async function fixture(t, assets = {}, local) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-asset-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(publicDir); await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'assets.json'), JSON.stringify(assets));
  if (local) await fs.writeFile(path.join(dataDir, 'local-assets.json'), JSON.stringify(local));
  const put = async (url, content) => {
    const target = path.join(publicDir, url.slice(1));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  return { root, publicDir, dataDir, put };
}

test('catalog hashes deployed bytes, deduplicates references and keeps stable order', async (t) => {
  const f = await fixture(t, { a: '/assets/icon.png', copies: ['/assets/icon.png'], fonts: { css: '/fonts/fonts.css' } });
  await f.put('/assets/icon.png', 'picture'); await f.put('/fonts/fonts.css', 'font style');
  await f.put('/assets/orphan.png', 'not referenced');
  const first = await createAssetCacheCatalog({ ...f, app: '0.2.2', concurrency: 2 });
  assert.equal(first.complete, true); assert.equal(first.totalFiles, 2); assert.equal(first.totalBytes, 17);
  assert.deepEqual(first.files.map((x) => x.url), ['/assets/icon.png', '/fonts/fonts.css']);
  assert.equal(first.files[0].sha256, createHash('sha256').update('picture').digest('hex'));
  const second = await createAssetCacheCatalog({ ...f, app: 'new code version' });
  assert.equal(second.version, first.version, 'app code version does not invalidate unchanged assets');
  await f.put('/assets/icon.png', 'changed');
  const changed = await createAssetCacheCatalog(f);
  assert.notEqual(changed.version, first.version, 'same path/length with changed bytes updates asset version');
});

test('missing and invalid declarations are reported without exposing absolute filesystem paths', async (t) => {
  const f = await fixture(t, { ok: '/assets/ok.png', missing: '/assets/missing.png', zero: '/assets/zero.png', bad: '/assets/../private.json', code: '/assets/malware.js', personal: '/api/announcement-assets/p.png' });
  await f.put('/assets/ok.png', 'ok'); await f.put('/assets/zero.png', '');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false); assert.equal(catalog.totalFiles, 1);
  assert.equal(catalog.missing.length, 4);
  assert.ok(!JSON.stringify(catalog).includes(f.root));
  assert.ok(!JSON.stringify(catalog).includes('/api/announcement-assets'));
});

test('media aliases match extension-less and explicit-extension priority/fallback', async (t) => {
  const f = await fixture(t, { audio: ['/assets/audio/bgm/track.ogg', '/assets/audio/bgm/track.mp3'] });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  const mp3 = catalog.files.find((x) => x.url.endsWith('.mp3'));
  const ogg = catalog.files.find((x) => x.url.endsWith('.ogg'));
  assert.ok(mp3.aliases.includes('/media/bgm/track'));
  assert.ok(mp3.aliases.includes('/media/bgm/track.wav'), 'missing explicit extension falls back to mp3');
  assert.ok(ogg.aliases.includes('/media/bgm/track.ogg'));
  assert.ok(!ogg.aliases.includes('/media/bgm/track'));
  assert.equal(new Set(catalog.files.flatMap((x) => x.aliases)).size, 8);
});

test('local token models and atlas-only texture dependencies enter the complete package', async (t) => {
  const prefix = '/assets/local/spine/token/token_mon3tr';
  const local = { groups: { 'spine/token/token_mon3tr': {
    skel: { path: `${prefix}/token.skel` }, atlas: { path: `${prefix}/token.atlas` },
  } } };
  const f = await fixture(t, {}, local);
  await f.put(`${prefix}/token.skel`, 'skeleton');
  await f.put(`${prefix}/token.atlas`, '\ntoken.png\nsize: 512,512\nformat: RGBA8888\nfilter: Linear,Linear\n\nsecond.png\nsize: 2,2\n');
  await f.put(`${prefix}/token.png`, 'page1'); await f.put(`${prefix}/second.png`, 'page2');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true); assert.equal(catalog.totalFiles, 4);
  await fs.unlink(path.join(f.publicDir, prefix.slice(1), 'second.png'));
  const missing = await createAssetCacheCatalog(f);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing, [{ url: `${prefix}/second.png`, reason: 'missing file' }]);
});

test('a missing texture referenced by a standard runtime Spine model remains blocking', async (t) => {
  const f = await fixture(t, { chars: { a: { spine: { skel: '/assets/op/a.skel', atlas: '/assets/op/a.atlas', textures: [] } } } });
  await f.put('/assets/op/a.skel', 'skeleton'); await f.put('/assets/op/a.atlas', '\nmissing.png\nsize: 2,2\n');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false);
  assert.deepEqual(catalog.missing, [{ url: '/assets/op/missing.png', reason: 'missing file' }]);
});

test('unused extracted UI atlas dependencies warn without blocking a complete runtime asset pack', async (t) => {
  const prefix = '/assets/local/ui/battle';
  const f = await fixture(t, { a: '/assets/icon.png' }, { groups: { 'ui/battle': {
    atlas: { path: `${prefix}/unused.atlas`, kind: 'TextAsset' }, skel: { path: `${prefix}/unused.skel`, kind: 'TextAsset' },
  } } });
  await f.put('/assets/icon.png', 'picture'); await f.put(`${prefix}/unused.skel`, 'unused skeleton');
  await f.put(`${prefix}/unused.atlas`, '\nunused.png\nsize: 2,2\n');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true); assert.equal(catalog.totalFiles, 3);
  assert.deepEqual(catalog.missing, []);
  assert.deepEqual(catalog.warnings, [{ url: `${prefix}/unused.png`, reason: 'unused atlas dependency: missing file' }]);
  assert.ok(catalog.files.some((file) => file.url.endsWith('/unused.atlas')));
});

test('media cache includes an installed resolver alternative omitted by the declared manifest', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.totalFiles, 2);
  assert.ok(catalog.files.find((x) => x.url.endsWith('.mp3')).aliases.includes('/media/bgm/track'));
  assert.ok(!catalog.files.find((x) => x.url.endsWith('.ogg')).aliases.includes('/media/bgm/track'));
});

test('missing declared audio does not hide a safe installed media resolver fallback', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.mp3', 'mp3 fallback');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false, 'a declared missing resource is still reported');
  assert.deepEqual(catalog.missing, [{ url: '/assets/audio/bgm/track.ogg', reason: 'missing file' }]);
  assert.equal(catalog.totalFiles, 1);
  assert.equal(catalog.files[0].url, '/assets/audio/bgm/track.mp3');
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track'));
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track.ogg'), 'explicit missing ogg follows server fallback to mp3');
  assert.equal(catalog.files[0].type, 'audio/mpeg');
  assert.equal(catalog.files[0].sha256, createHash('sha256').update('mp3 fallback').digest('hex'));
});

test('empty higher-priority media files cannot silently alias a different playable file', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', '');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false);
  assert.ok(!catalog.files[0].aliases.includes('/media/bgm/track'));
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track.ogg'));
});

test('board tiles table follows runtime WebP remapping without adding unused original PNG', async (t) => {
  const prefix = '/assets/local/map/autochess';
  const f = await fixture(t, {}, { groups: { 'map/autochess': { TX_autochessi_D: { path: `${prefix}/TX_autochessi_D.webp` } } } });
  await f.put(`${prefix}/TX_autochessi_D.webp`, 'webp');
  await f.put(`${prefix}/TX_autochessi_D.png`, 'old png');
  await f.put(`${prefix}/tiles.json`, JSON.stringify({ source: { D: { path: `${prefix}/TX_autochessi_D.png` } } }));
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.files.map((x) => x.url), [`${prefix}/TX_autochessi_D.webp`, `${prefix}/tiles.json`]);
});

test('links to private or other public files never enter catalog', async (t) => {
  const f = await fixture(t, { a: '/assets/link.png' });
  const target = path.join(f.root, 'private.png');
  await fs.writeFile(target, 'secret'); await fs.mkdir(path.join(f.publicDir, 'assets'));
  try { await fs.symlink(target, path.join(f.publicDir, 'assets', 'link.png')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS does not permit creating test symlinks'); return; } throw error; }
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.files.length, 0); assert.equal(catalog.complete, false);
  assert.equal(catalog.missing[0].reason, 'symbolic link refused');
});

test('missing required manifest and malformed optional manifest are never called complete', async (t) => {
  const f = await fixture(t, { a: '/assets/a.png' });
  await f.put('/assets/a.png', 'art'); await fs.unlink(path.join(f.dataDir, 'assets.json'));
  const missing = await createAssetCacheCatalog(f);
  assert.equal(missing.complete, false); assert.equal(missing.missing[0].url, '/data/assets.json');
  await fs.writeFile(path.join(f.dataDir, 'assets.json'), '{"a":"/assets/a.png"}');
  await fs.writeFile(path.join(f.dataDir, 'local-assets.json'), '{');
  const malformed = await createAssetCacheCatalog(f);
  assert.equal(malformed.complete, false); assert.equal(malformed.missing[0].url, '/data/local-assets.json');
});

test('path validation rejects executable, alternate stream, traversal and encoded paths', () => {
  for (const url of ['/assets/a.js', '/assets/../a.png', '/assets/.hidden.png', '/assets/a.png:secret', '/assets/%2e%2e/a.png', '/assets/a.png?x=1', '/assets/a\\b.png', '/fonts/private.json']) {
    assert.ok(assetCacheURLProblem(url), url);
  }
  assert.equal(assetCacheURLProblem('/assets/local/map/fx/[opt]merged_textures.png'), null);
});

test('catalog matches browser validation and canonical URL map for aliases', async (t) => {
  const f = await fixture(t, { audio: ['/assets/audio/a.ogg', '/assets/audio/a.mp3'], image: '/assets/icon.webp' });
  await f.put('/assets/audio/a.ogg', 'ogg'); await f.put('/assets/audio/a.mp3', 'mp3'); await f.put('/assets/icon.webp', 'webp');
  const catalog = await createAssetCacheCatalog(f);
  assert.doesNotThrow(() => validateAssetCatalog(catalog));
  const map = catalogURLMap(catalog);
  assert.equal(map.get('/media/a'), map.get('/assets/audio/a.mp3'));
  assert.equal(map.get('/assets/audio/a.ogg'), map.get('/media/a.ogg'));
});
