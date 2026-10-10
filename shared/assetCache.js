// Pure client catalog/cache helpers. This module never reads browser globals at import time.
export const CACHE_SCHEMA = 1;
export const ASSET_CACHE_NAME = 'sp-asset-cache-v1';
export const ASSET_CACHE_META = 'sp-asset-cache-meta-v1';
export const CACHE_KEY_PREFIX = '/__sp_asset_cache__/sha256/';
export const MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_CATALOG_FILES = 100000;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const TYPES = /\.(?:png|jpe?g|gif|webp|avif|bmp|mp3|m4a|aac|ogg|oga|opus|wav|woff2?|ttf|otf|css|json|atlas|obj|skel)$/i;

export function assetCacheError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

export function safeAssetPath(value, alias = false) {
  if (typeof value !== 'string' || !/^\/(?:assets|fonts)\//.test(value) && !(alias && value.startsWith('/media/'))) return false;
  if (/[\\\x00-\x1f\x7f?#%:]/.test(value)) return false;
  if (value.slice(1).split('/').some((part) => !part || part.startsWith('.') || /[. ]$/.test(part) || /[<>"|*]/.test(part))) return false;
  if (value.startsWith('/media/')) return alias;
  if (!TYPES.test(value)) return false;
  return !value.startsWith('/fonts/') || /\.(?:css|woff2?|ttf|otf)$/i.test(value);
}

export function safeAssetZipName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 512 && !name.startsWith('/')
    && !/[\\\x00-\x1f\x7f:]/.test(name)
    && !name.replace(/\/$/, '').split('/').some((part) => !part || part.startsWith('.') || /[. ]$/.test(part) || /[<>"|*]/.test(part));
}

/** Validate the authoritative server index before it can claim a URL or consume disk space. */
export function validateAssetCatalog(catalog) {
  if (!catalog || catalog.schema !== CACHE_SCHEMA || !SHA.test(catalog.version || '') || !Array.isArray(catalog.files)
    || !catalog.files.length || catalog.files.length > MAX_CATALOG_FILES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
  const urls = new Set();
  let bytes = 0;
  for (const file of catalog.files) {
    if (!file || !safeAssetPath(file.url) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_ASSET_BYTES
      || !SHA.test(file.sha256 || '') || typeof file.type !== 'string' || !file.type || /[\r\n]/.test(file.type)
      || !Array.isArray(file.aliases) || file.aliases.length > 16) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
    for (const url of [file.url, ...file.aliases]) {
      if (!safeAssetPath(url, true) || urls.has(url)) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
      urls.add(url);
    }
    bytes += file.bytes;
  }
  if (!Number.isSafeInteger(bytes) || catalog.totalFiles !== catalog.files.length || catalog.totalBytes !== bytes
    || typeof catalog.complete !== 'boolean' || !Array.isArray(catalog.missing)) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
  return catalog;
}

export function catalogURLMap(catalog) {
  const map = new Map();
  for (const entry of catalog.files) for (const url of [entry.url, ...entry.aliases]) map.set(url, entry);
  return map;
}

export const assetContentKey = (sha256) => {
  if (!SHA.test(sha256 || '')) throw assetCacheError('ASSET_CACHE_BAD_HASH');
  return CACHE_KEY_PREFIX + sha256;
};

/** Query suffixes are irrelevant for verified content. Encoded path separators are not. */
export function decodedAssetPath(url, origin) {
  try {
    const parsed = new (/** @type {any} */ (globalThis).URL)(url, origin);
    if (parsed.origin !== origin || /%(?:2f|5c|25)/i.test(parsed.pathname)) return null;
    const path = decodeURIComponent(parsed.pathname);
    return safeAssetPath(path, true) ? path : null;
  } catch { return null; }
}

/** Return a single satisfiable byte range; null = malformed/multiple/unsatisfiable. */
export function parseAssetRange(header, length) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || !Number.isSafeInteger(length) || length < 1 || !match[1] && !match[2]) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) return null;
  if (first === null) return last > 0 ? { start: Math.max(0, length - last), end: length - 1 } : null;
  if (first >= length || last !== null && last < first) return null;
  return { start: first, end: last === null ? length - 1 : Math.min(last, length - 1) };
}

export async function sha256Hex(buffer, cryptoAPI = globalThis.crypto) {
  const digest = await cryptoAPI.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validatedCacheHeaders(entry) {
  return { 'Content-Type': entry.type, 'Content-Length': String(entry.bytes),
    'X-SP-Asset-SHA256': entry.sha256, 'Cache-Control': 'public, max-age=31536000, immutable' };
}

/** Metadata is written only after content verification; quick scans also inspect actual cache entries. */
export function isVerifiedAssetResponse(response, entry) {
  return !!response && response.status === 200 && response.headers.get('x-sp-asset-sha256') === entry.sha256
    && response.headers.get('content-length') === String(entry.bytes);
}
