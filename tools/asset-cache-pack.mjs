#!/usr/bin/env node
// i18n-ignore-file: this owner CLI intentionally reports operational results in Chinese.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog, checkedAssetPath, assetCacheURLProblem } from '../server/assetCacheCatalog.js';
import { writeAssetZip } from './asset-cache/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSET_CACHE_PACK_MANIFEST = 'manifest.json';

/** Only a complete catalog can be described as a full distribution package. */
export function assetCachePackManifest(catalog) {
  if (!catalog?.complete || catalog.missing?.length || !catalog.files?.length) {
    const detail = catalog?.missing?.map((item) => `${item.url}：${item.reason}`).join('\n') || '没有可打包素材';
    throw new Error(`素材清单不完整，拒绝生成完整包：\n${detail}`);
  }
  const hex = /^[0-9a-f]{64}$/;
  if (catalog.schema !== 1 || !hex.test(catalog.version) || catalog.totalFiles !== catalog.files.length) throw new Error('素材清单格式或总数无效');
  const names = new Set();
  let totalBytes = 0;
  for (const file of catalog.files) {
    if (assetCacheURLProblem(file.url) || names.has(file.url) || !Number.isSafeInteger(file.bytes)
      || file.bytes <= 0 || !hex.test(file.sha256) || typeof file.type !== 'string' || !Array.isArray(file.aliases)) throw new Error('素材清单文件条目无效');
    names.add(file.url); totalBytes += file.bytes;
  }
  const version = createHash('sha256').update(JSON.stringify({ schema: catalog.schema, files: catalog.files })).digest('hex');
  if (catalog.totalBytes !== totalBytes || catalog.version !== version) throw new Error('素材清单总量或内容版本无效');
  return {
    schema: catalog.schema, version: catalog.version, app: catalog.app,
    totalFiles: catalog.totalFiles, totalBytes: catalog.totalBytes,
    files: catalog.files, complete: true, missing: [], warnings: catalog.warnings || [],
  };
}

/** No staging copy or archiver dependency: stream/hash/deflate one resource at a time. */
export async function packAssetCache({ root = REPO, out, catalog, onProgress = () => {} } = {}) {
  const publicDir = path.join(root, 'public');
  const source = catalog || await createAssetCacheCatalog({ publicDir, dataDir: path.join(root, 'data') });
  const manifest = assetCachePackManifest(source);
  const destination = path.resolve(out || path.join(root, '.cache', 'asset-cache-pack'));
  const stat = await fsp.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('输出位置必须为普通目录');
  await fsp.mkdir(destination, { recursive: true });
  const fileName = `Stronghold-Protocol-assets-${source.version.slice(0, 12)}.zip`;
  const zipPath = path.join(destination, fileName);
  // Exclusive creation refuses accidental replacement; a different content version gets a different name.
  const temporary = `${zipPath}.part`;
  let handle;
  let opened = false;
  try {
    if (await fsp.lstat(zipPath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error(`完整素材包已存在：${zipPath}`);
    }
    handle = await fsp.open(temporary, 'wx');
    opened = true;
    const entries = [{ name: ASSET_CACHE_PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest) + '\n', 'utf8') }];
    // Re-check immediately before use, including symlink components. The writer compares hashes again.
    for (const file of source.files) {
      const { filePath } = await checkedAssetPath(publicDir, file.url);
      entries.push({ name: file.url.slice(1), filePath, bytes: file.bytes, sha256: file.sha256 });
    }
    let done = 0;
    const result = await writeAssetZip(handle, entries, { onEntry: (entry) => {
      if (entry.name === ASSET_CACHE_PACK_MANIFEST) return;
      return onProgress({ ...entry, done: ++done, total: source.totalFiles });
    } });
    await handle.sync();
    await handle.close(); handle = null;
    // hard-link publishing is atomic and cannot overwrite an existing package on either OS.
    await fsp.link(temporary, zipPath);
    return { zipPath, zipBytes: result.bytes, totalFiles: source.totalFiles, totalBytes: source.totalBytes, version: source.version };
  } finally {
    if (handle) await handle.close();
    // Never delete a stale .part belonging to another invocation; only remove our opened file.
    if (opened) await fsp.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function parseAssetCachePackArgs(argv) {
  const options = { root: REPO, out: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root' || arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要目录路径`);
      options[arg.slice(2)] = path.resolve(value);
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const MiB = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
export async function main(argv) {
  try {
    const options = parseAssetCachePackArgs(argv);
    if (options.help) {
      console.log('用法：node tools/asset-cache-pack.mjs [--dry-run] [--out 输出目录] [--root 项目目录]');
      return 0;
    }
    console.log('读取素材清单并计算逐文件 SHA-256…');
    const catalog = await createAssetCacheCatalog({ publicDir: path.join(options.root, 'public'), dataDir: path.join(options.root, 'data') });
    console.log(`素材：${catalog.totalFiles} 个文件，${MiB(catalog.totalBytes)}，版本 ${catalog.version.slice(0, 12)}`);
    assetCachePackManifest(catalog);
    for (const warning of catalog.warnings || []) console.log(`提示（不影响完整性）：${warning.url}：${warning.reason}`);
    if (options.dryRun) { console.log('清单完整；仅核对，未生成文件。'); return 0; }
    const result = await packAssetCache({ ...options, catalog, onProgress: ({ done, total }) => {
      if (done % 500 === 0 || done === total) console.log(`打包进度：${done}/${total}`);
    } });
    console.log(`完整包：${result.zipPath}\n压缩后：${MiB(result.zipBytes)}；仅素材及校验清单，不含服务器程序或私人数据。`);
    return 0;
  } catch (error) { console.error(`素材打包失败：${error.message}`); return 1; }
}

// Node writes UTF-8 to pipes and Windows terminals; launch.cmd already selects the UTF-8 code page.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
