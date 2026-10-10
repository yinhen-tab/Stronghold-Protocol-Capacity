import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog } from '../server/assetCacheCatalog.js';
import { packAssetCache, assetCachePackManifest, parseAssetCachePackArgs } from '../tools/asset-cache-pack.mjs';
import { readZip } from '../tools/package-update.mjs';
import { writeAssetZip, updateCRC32 } from '../tools/asset-cache/zip.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-asset-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await fs.mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'assets', '头像.png'), 'art data');
  await fs.writeFile(path.join(root, 'public', 'assets', 'unlisted.png'), 'do not ship');
  await fs.writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify({ a: '/assets/头像.png' }));
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.2.2"}');
  return root;
}

test('full ZIP contains only manifest and selected art, with UTF-8 and verified byte contents', async (t) => {
  const root = await fixture(t);
  const r = await packAssetCache({ root });
  assert.equal(r.totalFiles, 1); assert.equal(r.totalBytes, 8);
  const entries = new Map();
  readZip(r.zipPath, (name, bytes) => entries.set(name, bytes));
  assert.deepEqual([...entries.keys()], ['manifest.json', 'assets/头像.png']);
  const manifest = JSON.parse(entries.get('manifest.json').toString());
  assert.equal(manifest.schema, 1); assert.equal(manifest.version, r.version);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(entries.get('assets/头像.png')).digest('hex'));
  assert.equal(entries.get('assets/头像.png').toString(), 'art data');
  assert.ok(!(await fs.readdir(path.dirname(r.zipPath))).some((x) => x.endsWith('.part')));
  await assert.rejects(packAssetCache({ root }), /已存在/);
});

test('incomplete catalog refuses full-pack creation and leaves no misleading package', async (t) => {
  const root = await fixture(t);
  await fs.unlink(path.join(root, 'public', 'assets', '头像.png'));
  await assert.rejects(packAssetCache({ root }), /不完整.*拒绝/s);
  assert.equal(await fs.access(path.join(root, '.cache')).then(() => true, () => false), false);
  assert.throws(() => assetCachePackManifest({ complete: true, files: [] }), /不完整/);
});

test('catalog-to-pack mutation is caught by a second hash and removes only its partial output', async (t) => {
  const root = await fixture(t);
  const catalog = await createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  await fs.writeFile(path.join(root, 'public', 'assets', '头像.png'), 'changed!');
  await assert.rejects(packAssetCache({ root, catalog }), /内容变化/);
  assert.deepEqual(await fs.readdir(path.join(root, '.cache', 'asset-cache-pack')), []);
});

test('a stale partial file belonging to another process is not overwritten or removed', async (t) => {
  const root = await fixture(t);
  const catalog = await createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  const out = path.join(root, '.cache', 'asset-cache-pack');
  await fs.mkdir(out, { recursive: true });
  const name = `Stronghold-Protocol-assets-${catalog.version.slice(0, 12)}.zip.part`;
  await fs.writeFile(path.join(out, name), 'other process');
  await assert.rejects(packAssetCache({ root, catalog }), /EEXIST/);
  assert.equal(await fs.readFile(path.join(out, name), 'utf8'), 'other process');
});

test('ZIP writer rejects unsafe/duplicate paths and writes interoperable CRC-32', async (t) => {
  const root = await fixture(t);
  assert.equal((updateCRC32(0xffffffff, Buffer.from('123456789')) ^ 0xffffffff) >>> 0, 0xcbf43926);
  for (const name of ['../x', '/x', 'assets/../x', 'assets\\x', 'assets/a:stream']) {
    const handle = await fs.open(path.join(root, 'bad.zip'), 'w');
    try { await assert.rejects(writeAssetZip(handle, [{ name, data: Buffer.from('x') }]), /不安全/); }
    finally { await handle.close(); }
  }
  const handle = await fs.open(path.join(root, 'bad.zip'), 'w');
  try { await assert.rejects(writeAssetZip(handle, [{ name: 'a', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]), /重复/); }
  finally { await handle.close(); }
});

test('pack CLI supports safe explicit roots/output and rejects accidental switches', () => {
  assert.equal(parseAssetCachePackArgs(['--dry-run']).dryRun, true);
  assert.equal(parseAssetCachePackArgs(['--help']).help, true);
  assert.throws(() => parseAssetCachePackArgs(['--out', '--dry-run']), /需要目录/);
  assert.throws(() => parseAssetCachePackArgs(['--upload']), /未知参数/);
});
