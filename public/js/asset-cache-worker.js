// The ZIP stays a File/Blob. Only one bounded entry is decompressed and hashed at a time.
// Disk IO, downloads, deep verification and ZIP work all run off the UI thread.
importScripts('/vendor/zip-native.min.js');
zip.configure({ useWebWorkers: false });
const helpers = import('../../shared/assetCache.js');
let active = null;

function cancelled() {
  if (active?.paused) throw Object.assign(new Error('ASSET_CACHE_PAUSED'), { code: 'ASSET_CACHE_PAUSED' });
}
const send = (id, type, value = {}) => self.postMessage({ id, type, ...value });

/** Only a bounded explicit response identifies why an online transfer was refused. */
async function unavailableCode(response) {
  if (!response.body) return 'ASSET_CACHE_DOWNLOAD_FAILED';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return 'ASSET_CACHE_DOWNLOAD_FAILED';
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.error;
    if (code === 'ASSET_CACHE_EMERGENCY' || code === 'SERVER_EMERGENCY') return 'ASSET_CACHE_EMERGENCY';
    return code === 'ASSET_CACHE_ONLINE_DISABLED' ? code : 'ASSET_CACHE_DOWNLOAD_FAILED';
  } catch { return 'ASSET_CACHE_DOWNLOAD_FAILED'; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

class LimitedWriter extends zip.Writer {
  constructor(limit) { super(); this.limit = limit; this.chunks = []; this.length = 0; }
  writeUint8Array(chunk) {
    cancelled();
    if (this.length + chunk.length > this.limit) {
      throw Object.assign(new Error('ASSET_CACHE_FILE_TOO_LARGE'), { code: 'ASSET_CACHE_FILE_TOO_LARGE' });
    }
    this.chunks.push(chunk); this.length += chunk.length;
  }
  getData() { return new Blob(this.chunks); }
}

async function archiveEntries(reader, h) {
  const entries = [], seen = new Set();
  for await (const entry of reader.getEntriesGenerator()) {
    cancelled();
    if (entries.length >= h.MAX_CATALOG_FILES * 2) throw h.assetCacheError('ASSET_CACHE_ZIP_TOO_LARGE');
    if (!h.safeAssetZipName(entry.filename) || entry.encrypted || entry.symlink || entry.executable || seen.has(entry.filename)) {
      throw h.assetCacheError('ASSET_CACHE_ZIP_UNSAFE');
    }
    seen.add(entry.filename); entries.push(entry);
  }
  return entries;
}

async function readCatalog(message, h) {
  if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
  let blob = message.file;
  let reader;
  try {
    if (message.format === 'zip') {
      reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false, checkSignature: true });
      const entries = await archiveEntries(reader, h);
      const entry = entries.find((item) => !item.directory && item.filename === 'manifest.json');
      if (!entry) throw h.assetCacheError('ASSET_CACHE_CATALOG_REQUIRED');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1
        || entry.uncompressedSize > h.MAX_MANIFEST_BYTES || ![0, 8].includes(entry.compressionMethod)) {
        throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
      }
      blob = await entry.getData(new LimitedWriter(h.MAX_MANIFEST_BYTES), { useWebWorkers: false, checkSignature: true,
        signal: active.abort.signal });
    } else if (message.format !== 'json') throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
    if (blob.size < 1 || blob.size > h.MAX_MANIFEST_BYTES) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
    const bytes = await blob.arrayBuffer();
    cancelled();
    const catalog = await h.verifyAssetCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    cancelled();
    return { catalog };
  } catch (error) {
    if (error.code) throw error;
    throw h.assetCacheError(message.format === 'zip' ? 'ASSET_CACHE_ZIP_INVALID' : 'ASSET_CACHE_BAD_CATALOG', error);
  } finally { await reader?.close(); }
}

async function work(message) {
  const h = await helpers;
  if (message.action === 'read-catalog') return readCatalog(message, h);
  const catalog = h.validateAssetCatalog(message.catalog);
  const origin = self.location.origin;
  const cache = await caches.open(h.ASSET_CACHE_NAME);
  const keys = await cache.keys();
  const hashes = new Map();
  for (const key of keys) {
    const hash = key.headers.get('x-sp-asset-sha256');
    if (/^[a-f0-9]{64}$/.test(hash || '') && key.url === origin + h.assetContentKey(hash)) {
      hashes.set(hash, Number(key.headers.get('x-sp-asset-bytes')));
    }
  }
  const ready = (entry) => hashes.get(entry.sha256) === entry.bytes;
  const report = (extra = {}) => {
    let readyFiles = 0, readyBytes = 0;
    for (const entry of catalog.files) if (ready(entry)) { readyFiles++; readyBytes += entry.bytes; }
    send(message.id, 'progress', { readyFiles, readyBytes, missingFiles: catalog.totalFiles - readyFiles,
      missingBytes: catalog.totalBytes - readyBytes, ...extra });
  };
  const store = async (entry, body) => {
    cancelled();
    if (body.byteLength !== entry.bytes || await h.sha256Hex(body) !== entry.sha256) throw h.assetCacheError('ASSET_CACHE_HASH_MISMATCH');
    cancelled();
    const request = new Request(origin + h.assetContentKey(entry.sha256), { headers: {
      'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
    await cache.put(request, new Response(body, { headers: h.validatedCacheHeaders(entry) }));
    hashes.set(entry.sha256, entry.bytes);
  };
  report();
  if (message.action === 'scan') {
    if (message.deep) {
      let checked = 0, invalid = 0;
      const verified = new Set();
      for (const entry of catalog.files) {
        cancelled();
        if (!ready(entry) || verified.has(entry.sha256)) continue;
        verified.add(entry.sha256);
        const response = await cache.match(origin + h.assetContentKey(entry.sha256));
        let valid = h.isVerifiedAssetResponse(response, entry);
        if (valid) {
          const body = await response.arrayBuffer();
          valid = body.byteLength === entry.bytes && await h.sha256Hex(body) === entry.sha256;
        }
        if (!valid) { hashes.delete(entry.sha256); await cache.delete(origin + h.assetContentKey(entry.sha256)); invalid++; }
        checked++;
        if (checked % 20 === 0) report({ scanStats: { checked, invalid } });
      }
      report({ scanStats: { checked, invalid } });
    }
  } else if (message.action === 'download') {
    let received = 0;
    const started = performance.now();
    for (const entry of catalog.files) {
      cancelled();
      if (ready(entry)) continue;
      let response;
      for (let retry = 0; retry < 6; retry++) {
        cancelled();
        response = await fetch(`/api/asset-cache/file?url=${encodeURIComponent(entry.url)}&hash=${entry.sha256}`, {
          cache: 'no-store', signal: active.abort.signal });
        if (response.status !== 429) break;
        const seconds = Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 3));
        report({ waiting: true, speedBps: 0 });
        await sleep(seconds * 1000, active.abort.signal);
      }
      if (response.status === 409) throw h.assetCacheError('ASSET_CACHE_STALE_CATALOG');
      if (response.status === 503) throw h.assetCacheError(await unavailableCode(response));
      if (response.status === 429) throw h.assetCacheError('ASSET_CACHE_BUSY');
      if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes)
        throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
      const buffer = new Uint8Array(entry.bytes);
      const reader = response.body.getReader();
      let offset = 0, lastReport = 0;
      try {
        while (true) {
          cancelled();
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > entry.bytes) throw h.assetCacheError('ASSET_CACHE_FILE_TOO_LARGE');
          buffer.set(chunk.value, offset); offset += chunk.value.length; received += chunk.value.length;
          if (performance.now() - lastReport > 250) {
            report({ waiting: false, speedBps: Math.round(received * 1000 / Math.max(1, performance.now() - started)) });
            lastReport = performance.now();
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (offset !== entry.bytes) throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
      await store(entry, buffer);
      report({ waiting: false, speedBps: Math.round(received * 1000 / Math.max(1, performance.now() - started)) });
    }
  } else if (message.action === 'import') {
    if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID');
    const reader = new zip.ZipReader(new zip.BlobReader(message.file), { useWebWorkers: false, checkSignature: true });
    let entries;
    const expected = new Map(catalog.files.map((entry) => [entry.url.slice(1), entry]));
    const stats = { imported: 0, reused: 0, invalid: 0, unknown: 0, absent: 0 };
    try {
      // Reject unsafe archives before writing any file. Ordinary old/extra asset entries are skipped.
      entries = await archiveEntries(reader, h);
      const candidates = entries.filter((entry) => !entry.directory && entry.filename !== 'manifest.json');
      const importedHashes = new Set();
      for (const entry of candidates) {
        cancelled();
        const target = expected.get(entry.filename);
        if (!target) { stats.unknown++; continue; }
        if (importedHashes.has(target.sha256) || ready(target)) { stats.reused++; continue; }
        if (entry.uncompressedSize !== target.bytes || ![0, 8].includes(entry.compressionMethod)) { stats.invalid++; continue; }
        try {
          const blob = await entry.getData(new LimitedWriter(target.bytes), { useWebWorkers: false, checkSignature: true,
            signal: active.abort.signal });
          const body = await blob.arrayBuffer();
          if (body.byteLength !== target.bytes || await h.sha256Hex(body) !== target.sha256) { stats.invalid++; continue; }
          await store(target, body); importedHashes.add(target.sha256); stats.imported++;
        } catch (error) {
          if (active.paused || error.name === 'QuotaExceededError') throw error;
          stats.invalid++;
        }
        if ((stats.imported + stats.reused + stats.invalid) % 10 === 0) report({ importStats: { ...stats } });
      }
      stats.absent = catalog.files.filter((entry) => !ready(entry)).length;
      report({ importStats: stats });
    } catch (error) {
      if (error.code || error.name === 'QuotaExceededError') throw error;
      throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID', error);
    } finally { await reader.close(); }
  } else throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
  report({ speedBps: 0, waiting: false });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new DOMException('Paused', 'AbortError')); }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'pause') { if (active) { active.paused = true; active.abort.abort(); } return; }
  if (active) { send(data?.id, 'error', { code: 'ASSET_CACHE_BUSY' }); return; }
  active = { id: data.id, paused: false, abort: new AbortController() };
  try { const result = await work(data); send(data.id, 'done', result); }
  catch (error) { send(data.id, 'error', { code: active.paused ? 'ASSET_CACHE_PAUSED'
    : error.name === 'QuotaExceededError' ? 'ASSET_CACHE_QUOTA' : error.code || 'ASSET_CACHE_STORAGE_ERROR' }); }
  finally { active = null; }
};
