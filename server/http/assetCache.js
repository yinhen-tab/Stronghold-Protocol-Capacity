// Only the opt-in filling route is rate-limited. Game requests continue through static.js/media.js unchanged.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createAssetCacheCatalog, checkedAssetPath } from '../assetCacheCatalog.js';
import { clientAddress } from '../net.js';
import { parseTrustProxy } from './config.js';
import { acceptsGzip, MIME } from './files.js';
import { sendJson } from './common.js';
import { CacheDownloadLimiter } from './cacheLimiter.js';

export const ASSET_CACHE_PREFIX = '/api/asset-cache/';
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function failure(req, res, status, error) { sendJson(req, res, status, { error }); }

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Catalog URLs are allowlisted; also reject symlinks/replacements at use time, after the catalog's initial scan. */
async function openAsset(publicDir, url) {
  const { filePath, stat: before } = await checkedAssetPath(publicDir, url);
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameFile(before, after)) throw new Error('asset replaced while opening');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Bounded-memory verification before headers: never silently transfer changed bytes under an old SHA-256. */
async function verifyAsset(handle, entry, canceled) {
  const before = await handle.stat();
  if (before.size !== entry.bytes) return false;
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let position = 0; position < entry.bytes;) {
    if (canceled()) return false;
    const length = Math.min(buffer.length, entry.bytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) return false;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex') === entry.sha256 && sameFile(before, await handle.stat());
}

export function createAssetCacheHandler({ publicDir, dataDir, log, limits, trustProxy, buildCatalog = createAssetCacheCatalog }) {
  const limiter = new CacheDownloadLimiter(limits);
  const proxy = trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  let pending = null;
  // One immutable catalog per server lifetime, shared by status, index and every filling request.
  // Failure is retryable (e.g. setup still copying files); a successful snapshot changes only after restart.
  async function snapshot() {
    if (!pending) pending = Promise.resolve().then(() => buildCatalog({ publicDir, dataDir })).then((catalog) => {
      const json = Buffer.from(JSON.stringify(catalog));
      const byUrl = new Map(catalog.files.map((entry) => [entry.url, entry]));
      // `version` is the reusable file-content version; the HTTP validator must also change
      // when completeness, warnings or application metadata changes without changing bytes.
      const entityTag = createHash('sha256').update(json).digest('hex');
      return { catalog, byUrl, json, gzip: gzipSync(json), etag: `"asset-cache-${entityTag}"` };
    }).catch((error) => { pending = null; throw error; });
    return pending;
  }

  async function serve(req, res, rawPath, query) {
    if (rawPath !== `${ASSET_CACHE_PREFIX}status` && rawPath !== `${ASSET_CACHE_PREFIX}catalog` && rawPath !== `${ASSET_CACHE_PREFIX}file`) {
      failure(req, res, 404, 'ASSET_CACHE_ROUTE_NOT_FOUND'); return;
    }
    let state;
    try { state = await snapshot(); } catch (error) {
      log?.warn?.('[asset-cache] catalog unavailable', error.message);
      res.setHeader('Retry-After', '5');
      failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE'); return;
    }
    if (res.destroyed) return;
    if (rawPath === `${ASSET_CACHE_PREFIX}status`) {
      const { schema, version, app, totalFiles, totalBytes, complete, missing } = state.catalog;
      sendJson(req, res, 200, { schema, version, app, totalFiles, totalBytes, complete,
        missingFiles: missing.length, policy: limiter.policy() }); return;
    }
    if (rawPath === `${ASSET_CACHE_PREFIX}catalog`) {
      const useGzip = acceptsGzip(req.headers['accept-encoding']);
      const body = useGzip ? state.gzip : state.json;
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache',
        ETag: state.etag, Vary: 'Accept-Encoding' };
      if (typeof req.headers['if-none-match'] === 'string' && req.headers['if-none-match'].split(',').some((tag) => tag.trim().replace(/^W\//, '') === state.etag)) {
        res.writeHead(304, headers); res.end(); return;
      }
      if (useGzip) headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    const params = new URLSearchParams(query);
    const url = params.get('url');
    const hash = params.get('hash');
    if (!url || !hash || !HASH_PATTERN.test(hash) || params.getAll('url').length !== 1 || params.getAll('hash').length !== 1) {
      failure(req, res, 400, 'ASSET_CACHE_INVALID_REQUEST'); return;
    }
    const entry = state.byUrl.get(url);
    if (!entry) { failure(req, res, 404, 'ASSET_CACHE_FILE_NOT_FOUND'); return; }
    if (hash !== entry.sha256) { failure(req, res, 409, 'ASSET_CACHE_STALE_HASH'); return; }
    if (req.headers.range) { failure(req, res, 400, 'ASSET_CACHE_RANGE_UNSUPPORTED'); return; }
    const headers = { 'Content-Type': entry.type || MIME[path.extname(entry.url)] || 'application/octet-stream',
      'Content-Length': entry.bytes, 'Cache-Control': 'no-store', 'X-Asset-SHA256': entry.sha256,
      'X-Accel-Buffering': 'no', 'Accept-Ranges': 'none' };
    // Metadata-only requests cannot consume a streaming slot or bypass the online-disable switch.
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    if (!limiter.policy().enabled) { failure(req, res, 503, 'ASSET_CACHE_ONLINE_DISABLED'); return; }
    const key = clientAddress(req, proxy).ip;
    const lease = limiter.acquire(key);
    if (!lease) {
      res.setHeader('Retry-After', '3'); failure(req, res, 429, 'ASSET_CACHE_BUSY'); return;
    }
    const cancel = () => lease.release();
    res.once('close', cancel);
    let handle;
    try {
      handle = await openAsset(publicDir, entry.url);
      if (lease.released || res.destroyed) return;
      if (!(await verifyAsset(handle, entry, () => lease.released || res.destroyed))) {
        if (!res.destroyed) failure(req, res, 409, 'ASSET_CACHE_SOURCE_CHANGED'); return;
      }
      if (lease.released || res.destroyed) return;
      res.writeHead(200, headers);
      await lease.stream(handle, res, entry.bytes);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) failure(req, res, 409, 'ASSET_CACHE_SOURCE_CHANGED');
      else if (!res.destroyed) res.destroy();
      log?.debug?.('[asset-cache] download unavailable', error.message);
    } finally {
      res.off('close', cancel); lease.release();
      await handle?.close().catch(() => {});
    }
  }

  return { serve, close: () => limiter.close(), policy: () => limiter.policy() };
}
