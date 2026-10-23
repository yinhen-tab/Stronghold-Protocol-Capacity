// Browser asset-cache coordinator; pure at import time so importing it under Node is safe.
// All expensive work runs in a dedicated worker. UI consumes codes through i18n, never raw errors.
import { ASSET_CACHE_META, ASSET_CACHE_LATEST_KEY, ASSET_CACHE_SW_PROTOCOL, MAX_MANIFEST_BYTES, verifyAssetCatalog,
  assetCacheCatalogKey, validateAssetCacheSummary, catalogMatchesSummary, assetCacheError } from '../../shared/assetCache.js';

const initialState = (env) => {
  const supported = !!(env.isSecureContext && env.caches && env.navigator?.serviceWorker
    && env.Worker && env.crypto?.subtle && env.navigator?.locks);
  return { supported, phase: 'idle', error: null,
    totalFiles: 0, readyFiles: 0, totalBytes: 0, readyBytes: 0, missingFiles: 0, missingBytes: 0,
    speedBps: 0, version: null, storage: { usage: 0, quota: 0, persisted: false,
      persistenceSupported: supported && typeof env.navigator?.storage?.persist === 'function' }, playing: false,
    hasCatalog: false, catalogCurrent: false, catalogComplete: false, serverMissingFiles: 0,
    serverVersion: null, requireAssetCache: false, importStats: null, scanStats: null, waiting: false, policy: null,
    catalogUpdateRetryAt: 0, emergency: false,
    persistence: 'idle' };
};

export function createAssetCacheManager({ environment = globalThis, doFetch, workerURL = '/js/asset-cache-worker.js',
  swURL = '/asset-cache-sw.js', statusURL = '/api/asset-cache/status',
  catalogURL = '/api/asset-cache/catalog', catalogUpdateURL = '/api/asset-cache/catalog-update' } = {}) {
  const env = environment;
  const state = initialState(env);
  const listeners = new Set();
  const fetcher = doFetch || ((...args) => env.fetch(...args));
  let catalog = null;
  let initialized = false;
  let initializing = null;
  let registration = null;
  let ownPlaying = false;
  let worker = null;
  let task = null;
  let nextID = 0;
  let operation = null;
  let backgroundTimer = null;
  let checkingStorage = null;
  let summary = null;
  let checkingSummary = null;
  let admissionRefresh = null;
  let summaryAt = 0;
  let persistenceRequest = null;
  let compatibleSW = null;
  const getState = () => ({ ...state, storage: { ...state.storage }, importStats: state.importStats && { ...state.importStats },
    scanStats: state.scanStats && { ...state.scanStats }, policy: state.policy && { ...state.policy } });
  const patch = (next) => {
    Object.assign(state, next);
    for (const fn of [...listeners]) { try { fn(getState()); } catch { /* Consumer must not break cache progress. */ } }
  };

  function timeLimited(promise, ms, code) {
    return new Promise((resolve, reject) => {
      const timer = env.setTimeout(() => reject(assetCacheError(code)), ms);
      promise.then((value) => { env.clearTimeout(timer); resolve(value); }, (error) => { env.clearTimeout(timer); reject(error); });
    });
  }

  async function updateStorage() {
    if (checkingStorage) return checkingStorage;
    checkingStorage = (async () => {
      // Quota and persistence inspection can fail independently in private browser modes.
      const [estimate, persisted] = await Promise.allSettled([
        Promise.resolve().then(() => env.navigator.storage?.estimate?.()),
        Promise.resolve().then(() => env.navigator.storage?.persisted?.()),
      ]);
      patch({ storage: { ...state.storage,
        ...(estimate.status === 'fulfilled' && estimate.value
          ? { usage: estimate.value.usage || 0, quota: estimate.value.quota || 0 } : {}),
        ...(persisted.status === 'fulfilled' && typeof persisted.value === 'boolean'
          ? { persisted: persisted.value } : {}),
      } });
    })();
    try { await checkingStorage; } finally { checkingStorage = null; }
  }

  async function swMessage(type, payload = {}, target = env.navigator.serviceWorker.controller || registration?.active) {
    if (!target) throw assetCacheError('ASSET_CACHE_SW_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const channel = new env.MessageChannel();
      const timer = env.setTimeout(() => { channel.port1.close(); reject(assetCacheError('ASSET_CACHE_SW_UNAVAILABLE')); }, 10000);
      channel.port1.onmessage = ({ data }) => {
        env.clearTimeout(timer); channel.port1.close();
        if (data?.ok) resolve(data); else reject(assetCacheError(data?.error || 'ASSET_CACHE_STORAGE_ERROR'));
      };
      try { target.postMessage({ type, ...payload }, [channel.port2]); }
      catch (error) { env.clearTimeout(timer); channel.port1.close(); reject(assetCacheError('ASSET_CACHE_SW_UNAVAILABLE', error)); }
    });
  }

  function waitForSW(worker, states) {
    if (states.includes(worker.state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        env.clearTimeout(timer); worker.removeEventListener('statechange', changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => {
        if (states.includes(worker.state)) finish();
        else if (worker.state === 'redundant') finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED'));
      };
      const timer = env.setTimeout(() => finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED')), 15000);
      worker.addEventListener('statechange', changed);
      changed();
    });
  }

  function waitForController(target) {
    const serviceWorker = env.navigator.serviceWorker;
    if (serviceWorker.controller === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        env.clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (serviceWorker.controller === target) finish(); };
      const timer = env.setTimeout(() => finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED')), 15000);
      serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  }

  // Reloading can leave a new page controlled by the previous SW, whose catalog validator
  // cannot accept new aliases. Explicit maintenance upgrades it before any catalog transfer;
  // the waiting worker independently checks every live playing pin before skipWaiting.
  async function ensureCompatibleSW(job) {
    const target = () => env.navigator.serviceWorker.controller || registration?.active;
    const compatible = async () => {
      const current = target();
      if (current && current === compatibleSW) return true;
      try {
        const response = await swMessage('ASSET_CACHE_CAPABILITIES', {}, current);
        if (response.protocol === ASSET_CACHE_SW_PROTOCOL) { compatibleSW = current; return true; }
      } catch { /* Previous SW protocols respond with BAD_MESSAGE; update safely below. */ }
      return false;
    };
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    if (await compatible()) return;
    try {
      if (!registration?.waiting) {
        await timeLimited(registration.update(), 15000, 'ASSET_CACHE_SW_UPDATE_REQUIRED');
        if (registration.installing) await waitForSW(registration.installing, ['installed', 'activated']);
      }
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
      await assertMutable();
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
      const waiting = registration.waiting;
      if (waiting) {
        await swMessage('ASSET_CACHE_ACTIVATE', {}, waiting);
        await waitForSW(waiting, ['activated']);
        await waitForController(waiting);
      }
      if (!await compatible()) throw assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED');
    } catch (error) {
      if (error.code === 'ASSET_CACHE_PLAYING' || error.code === 'ASSET_CACHE_PAUSED') throw error;
      throw assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED', error);
    }
    await assertMutable();
  }

  const settledPhase = () => !catalog ? 'catalog-required' : !state.catalogCurrent ? 'catalog-stale'
    : state.missingFiles || !state.catalogComplete ? 'idle' : 'ready';

  async function refreshSummary({ force = false } = {}) {
    if (state.emergency) {
      if (summary) return summary;
      throw assetCacheError('ASSET_CACHE_EMERGENCY');
    }
    if (checkingSummary) return checkingSummary;
    if (!force && summary && Date.now() - summaryAt < 30000) return summary;
    checkingSummary = (async () => {
      const abort = new env.AbortController();
      const timer = env.setTimeout(() => abort.abort(), 15000);
      try {
        const response = await fetcher(statusURL, { cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
        const next = validateAssetCacheSummary(await response.json());
        summary = next; summaryAt = Date.now();
        patch({ catalogCurrent: catalogMatchesSummary(catalog, next), catalogComplete: next.complete,
          serverMissingFiles: next.missingFiles, serverVersion: next.version,
          requireAssetCache: !!next.requireAssetCache, policy: next.policy || null,
          ...(!catalog ? { totalFiles: next.totalFiles, totalBytes: next.totalBytes,
            missingFiles: next.totalFiles, missingBytes: next.totalBytes } : {}) });
        return next;
      } catch (error) {
        summary = null; summaryAt = 0;
        patch({ catalogCurrent: false });
        throw error.code ? error : assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE', error);
      }
      finally { env.clearTimeout(timer); }
    })();
    try { return await checkingSummary; } finally { checkingSummary = null; }
  }

  /** Cache Storage is the only directory source on reload, including older SW installations. */
  async function localCatalog() {
    const meta = await env.caches.open(ASSET_CACHE_META);
    const origin = env.location.origin;
    const latest = await (await meta.match(origin + ASSET_CACHE_LATEST_KEY))?.json();
    if (!latest?.version) return null;
    const response = await meta.match(origin + assetCacheCatalogKey(latest.version));
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { throw assetCacheError('ASSET_CACHE_BAD_CATALOG', error); }
    const next = await verifyAssetCatalog(value, env.crypto);
    if (next.version !== latest.version) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
    return next;
  }

  async function adoptCatalog(value, { restoring = false } = {}) {
    const next = await verifyAssetCatalog(value, env.crypto);
    if (!restoring && !catalogMatchesSummary(next, summary)) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
    if (ownPlaying && catalog && catalog.version !== next.version) throw assetCacheError('ASSET_CACHE_PLAYING');
    await swMessage('ASSET_CACHE_PIN', { catalog: next, playing: ownPlaying });
    const changed = catalog?.version !== next.version;
    catalog = next;
    patch({ version: next.version, hasCatalog: true, totalFiles: next.totalFiles, totalBytes: next.totalBytes,
      catalogCurrent: catalogMatchesSummary(next, summary),
      ...(changed ? { readyFiles: 0, readyBytes: 0, missingFiles: next.totalFiles, missingBytes: next.totalBytes, importStats: null } : {}) });
    return next;
  }

  async function adoptMatchingLocalCatalog() {
    if (ownPlaying || state.catalogCurrent) return;
    const next = await localCatalog();
    if (catalogMatchesSummary(next, summary)) await adoptCatalog(next);
  }

  function stopWorker(code = 'ASSET_CACHE_PAUSED') {
    if (!worker) return;
    worker.terminate(); worker = null;
    const previous = task; task = null;
    previous?.reject(assetCacheError(code));
  }

  function runWorker(action, extra = {}) {
    if (task) throw assetCacheError('ASSET_CACHE_BUSY');
    if (!worker) {
      try { worker = new env.Worker(workerURL); }
      catch (error) { throw assetCacheError('ASSET_CACHE_WORKER_UNAVAILABLE', error); }
      worker.onmessage = ({ data }) => {
        if (!task || data.id !== task.id) return;
        if (data.type === 'progress') {
          const { readyFiles, readyBytes, missingFiles, missingBytes, speedBps, importStats, scanStats, waiting } = data;
          patch({ readyFiles, readyBytes, missingFiles, missingBytes,
            ...(speedBps === undefined ? {} : { speedBps }), ...(importStats ? { importStats } : {}),
            ...(scanStats ? { scanStats } : {}), ...(waiting === undefined ? {} : { waiting }) });
        } else if (data.type === 'done' || data.type === 'error') {
          const finished = task; task = null;
          if (data.type === 'done') finished.resolve(data.catalog ? { catalog: data.catalog } : getState());
          else finished.reject(assetCacheError(data.code || 'ASSET_CACHE_STORAGE_ERROR'));
        }
      };
      worker.onerror = () => stopWorker('ASSET_CACHE_WORKER_UNAVAILABLE');
      worker.onmessageerror = () => stopWorker('ASSET_CACHE_WORKER_UNAVAILABLE');
    }
    return new Promise((resolve, reject) => {
      task = { id: ++nextID, resolve, reject };
      try { worker.postMessage({ id: task.id, action, catalog, ...extra }); }
      catch (error) { task = null; reject(assetCacheError('ASSET_CACHE_WORKER_UNAVAILABLE', error)); }
    });
  }

  async function assertMutable() {
    const result = await swMessage('ASSET_CACHE_CAN_MUTATE');
    patch({ playing: ownPlaying || !!result.playing });
    if (state.playing) throw assetCacheError('ASSET_CACHE_PLAYING');
  }

  function passiveScan() {
    if (!initialized || operation || backgroundTimer !== null) return;
    backgroundTimer = env.setTimeout(() => {
      backgroundTimer = null;
      if (!operation) perform('scan', { refresh: false }).catch(() => {});
    }, 1000);
  }

  // A room create should not wait for a second full Cache Storage walk when the last local
  // scan already proved the current catalog complete. Recheck in the background so later
  // admissions still observe evictions without putting the initial click on the critical path.
  function refreshAdmissionInBackground() {
    if (admissionRefresh || operation || !initialized) return;
    admissionRefresh = Promise.resolve().then(() => scan({ refresh: true })).catch(() => {}).finally(() => {
      admissionRefresh = null;
    });
  }

  function onSWMessage({ data }) {
    if (data?.type === 'ASSET_CACHE_PLAYING_CHANGED') {
      patch({ playing: ownPlaying || !!data.playing });
      if (data.playing && operation) pause();
    } else if (data?.type === 'ASSET_CACHE_UPDATED') passiveScan();
  }

  async function initialize() {
    if (initialized) {
      // Reopening the panel does not fetch or scan the directory. Recheck only the live-tab guard,
      // since another playing tab may have closed without sending a final message.
      if (!operation) {
        try { const result = await swMessage('ASSET_CACHE_CAN_MUTATE'); patch({ playing: ownPlaying || !!result.playing }); }
        catch { /* Explicit operations report SW failures; opening the dialog stays usable. */ }
      }
      return getState();
    }
    if (initializing) return initializing;
    if (!state.supported) {
      patch({ phase: 'unsupported', error: env.isSecureContext ? 'ASSET_CACHE_UNSUPPORTED' : 'ASSET_CACHE_HTTPS_REQUIRED' });
      return getState();
    }
    initializing = (async () => {
      patch({ phase: 'initializing', error: null });
      try {
        registration = await timeLimited(env.navigator.serviceWorker.register(swURL, { scope: '/', type: 'module', updateViaCache: 'none' }),
          15000, 'ASSET_CACHE_SW_UNAVAILABLE');
        registration = await timeLimited(env.navigator.serviceWorker.ready, 15000, 'ASSET_CACHE_SW_UNAVAILABLE');
        env.navigator.serviceWorker.addEventListener('message', onSWMessage);
        let restoreError = null;
        try {
          const local = await localCatalog();
          // Pin before PLAYING so an older active SW can also restore a direct match reconnect.
          if (local) await adoptCatalog(local, { restoring: true });
        } catch (error) { restoreError = error.code || 'ASSET_CACHE_STORAGE_ERROR'; }
        const playback = await swMessage('ASSET_CACHE_PLAYING', { playing: ownPlaying });
        patch({ playing: ownPlaying || !!playback.playing });
        initialized = true;
        let summaryError = null;
        try { await refreshSummary(); }
        catch (error) { summaryError = error.code || 'ASSET_CACHE_CATALOG_UNAVAILABLE'; }
        if (catalog) await runWorker('scan');
        patch({ phase: settledPhase(), error: restoreError || summaryError });
        await updateStorage();
      } catch (error) {
        const paused = error.code === 'ASSET_CACHE_PLAYING' || error.code === 'ASSET_CACHE_PAUSED';
        patch({ phase: paused ? 'paused' : 'error', error: paused ? null : error.code || 'ASSET_CACHE_STORAGE_ERROR' });
      }
      return getState();
    })();
    try { return await initializing; } finally { initializing = null; }
  }

  async function ensureReady() {
    await initialize();
    if (!initialized) throw assetCacheError(state.error || 'ASSET_CACHE_UNSUPPORTED');
  }

  // Only an explicit owner action may transfer the full directory. Checking, admission and
  // initialization continue to use the small status summary.
  async function fetchCatalogUpdate(job, { full = false } = {}) {
    if (Date.now() < state.catalogUpdateRetryAt) throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
    const abort = new env.AbortController();
    job.abort = abort;
    const timer = env.setTimeout(() => abort.abort(), 120000);
    try {
      const params = new URLSearchParams({ from: catalog?.version || '', to: summary.version,
        readyFiles: String(state.readyFiles), readyBytes: String(state.readyBytes) });
      const response = await fetcher(full ? catalogURL : `${catalogUpdateURL}?${params}`, { cache: 'no-store', signal: abort.signal,
        headers: full ? {} : { 'X-Asset-Cache-Update': 'manual' } });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delay = /^\d+(?:\.\d+)?$/.test(retryAfter || '')
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter || '') - Date.now();
          // Honor the server's real remaining cooldown; a transport/validation failure is not
          // evidence of rate limiting, and cold-directory acquisition has no fixed cooldown.
          patch({ catalogUpdateRetryAt: Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 1000) });
          throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
        }
        if (!full && response.status === 409) {
          await refreshSummary({ force: true });
          throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
        }
        if (response.status === 503) {
          // 503 also means catalogue construction/compression failed. Only the server's explicit
          // small error code proves that the owner disabled online transfers.
          let unavailable = 'ASSET_CACHE_CATALOG_UNAVAILABLE';
          if (response.body && Number(response.headers.get('Content-Length')) <= 4096) {
            const reader = response.body.getReader();
            const cancel = () => { reader.cancel().catch(() => {}); };
            abort.signal.addEventListener('abort', cancel, { once: true });
            try {
              const chunks = []; let size = 0;
              while (true) {
                if (job.paused || abort.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 4096) break;
                chunks.push(value);
              }
              if (size <= 4096 && !abort.signal.aborted && !job.paused) {
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.error;
                if (code === 'ASSET_CACHE_ONLINE_DISABLED') unavailable = code;
                else if (code === 'ASSET_CACHE_EMERGENCY' || code === 'SERVER_EMERGENCY') unavailable = 'ASSET_CACHE_EMERGENCY';
              }
            } catch { /* Unknown/unreadable server errors stay unavailable, not owner-disabled. */ }
            finally {
              abort.signal.removeEventListener('abort', cancel);
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          throw assetCacheError(unavailable);
        }
        throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
      }
      // Content-Length can be compressed. Always bound the *decoded* stream too, before JSON
      // parsing or adoption, so gzip cannot bypass the same limit used by local ZIP/JSON imports.
      if (Number(response.headers.get('Content-Length')) > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
      if (!response.body) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
      const reader = response.body.getReader();
      const cancel = () => { reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      const chunks = []; let size = 0;
      try {
        while (true) {
          if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
          if (abort.signal.aborted) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
          chunks.push(value);
        }
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
      if (abort.signal.aborted) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch (error) { throw assetCacheError('ASSET_CACHE_BAD_CATALOG', error); }
      return await verifyAssetCatalog(value, env.crypto);
    } catch (error) {
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED', error);
      throw error.code ? error : assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE', error);
    } finally {
      env.clearTimeout(timer);
      // Header/body validation can reject before acquiring a reader. Abort in every exit path
      // too, releasing the server's shared transfer lease rather than leaving a response flowing.
      abort.abort();
      job.abort = null;
    }
  }

  async function acquireCurrentCatalog(job) {
    if (catalog && state.catalogCurrent) return;
    if (Date.now() < state.catalogUpdateRetryAt) throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
    if (catalog) {
      await runWorker('scan');
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    }
    const full = !catalog || !state.readyFiles || !state.readyBytes;
    await assertMutable();
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    const next = await fetchCatalogUpdate(job, { full });
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    // Recheck deployment and every playing tab after transfer. A failed adoption preserves
    // the old directory and all verified contents, even for an empty old catalog.
    await refreshSummary({ force: true });
    if (!catalogMatchesSummary(next, summary)) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
    await assertMutable();
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    await adoptCatalog(next);
  }

  async function perform(action, { deep = false, file = null, refresh = false } = {}) {
    if (state.emergency && (action === 'download' || action === 'catalog-update')) throw assetCacheError('ASSET_CACHE_EMERGENCY');
    await ensureReady();
    if (state.emergency && (action === 'download' || action === 'catalog-update')) throw assetCacheError('ASSET_CACHE_EMERGENCY');
    if (operation) throw assetCacheError('ASSET_CACHE_BUSY');
    const phase = action === 'catalog-update' ? 'updating-catalog' : action === 'import' || action === 'catalog' ? 'importing'
      : action === 'download' ? 'downloading' : deep ? 'verifying' : 'checking';
    const mutates = action !== 'scan' || deep;
    const job = { paused: false, action };
    operation = job;
    patch({ phase, error: null, speedBps: 0, waiting: false,
      ...(action === 'import' ? { importStats: null } : {}), ...(deep ? { scanStats: null } : {}) });
    try {
      const run = async () => {
        if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
        if (mutates) {
          await assertMutable();
          if (action !== 'clear') await ensureCompatibleSW(job);
          if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
          if (action !== 'clear') await refreshSummary({ force: true });
          if (action === 'catalog-update') {
            await acquireCurrentCatalog(job);
          } else if (action === 'catalog') {
            const result = await runWorker('read-catalog', { file, format: 'json' });
            if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
            await assertMutable();
            await adoptCatalog(result.catalog);
          } else if (action !== 'clear') {
            await adoptMatchingLocalCatalog();
            // A cold browser has no local directory to index. The explicit online fill action
            // may fetch the current directory first, then continue through the normal worker
            // download path. This keeps ordinary checks/status requests small while making the
            // user initiated "download missing" action self contained.
            if (action === 'download' && !state.catalogCurrent) await acquireCurrentCatalog(job);
            if (action === 'import' && !state.catalogCurrent) {
              const result = await runWorker('read-catalog', { file, format: 'zip' });
              if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
              await assertMutable();
              await adoptCatalog(result.catalog);
            }
            if (!catalog) throw assetCacheError('ASSET_CACHE_CATALOG_REQUIRED');
            if (!state.catalogCurrent) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
          }
          await assertMutable();
        } else if (refresh) {
          await refreshSummary({ force: true });
          await adoptMatchingLocalCatalog();
        }
        if (!mutates) {
          const playback = await swMessage('ASSET_CACHE_CAN_MUTATE');
          patch({ playing: ownPlaying || !!playback.playing });
        }
        if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
        if (action === 'clear') {
          await swMessage('ASSET_CACHE_CLEAR');
          patch({ readyFiles: 0, readyBytes: 0, missingFiles: state.totalFiles, missingBytes: state.totalBytes });
        } else if (catalog) {
          await runWorker(action === 'catalog' || action === 'catalog-update' ? 'scan' : action, { deep, ...(file ? { file } : {}) });
          if (action === 'import' || action === 'download') await swMessage('ASSET_CACHE_PRUNE');
        }
      };
      if (mutates) await env.navigator.locks.request('sp-asset-cache-mutation', { ifAvailable: true }, async (lock) => {
        if (!lock) throw assetCacheError('ASSET_CACHE_BUSY');
        await run();
      });
      else await run();
      patch({ phase: settledPhase(), speedBps: 0, waiting: false });
      return getState();
    } catch (error) {
      const code = job.paused ? 'ASSET_CACHE_PAUSED' : error.code || 'ASSET_CACHE_STORAGE_ERROR';
      patch({ phase: code === 'ASSET_CACHE_PAUSED' ? 'paused' : 'error', error: code === 'ASSET_CACHE_PAUSED' ? null : code,
        speedBps: 0, waiting: false });
      // Pausing is a successful user action, and must not create an unhandled promise rejection.
      if (code === 'ASSET_CACHE_PAUSED') return getState();
      throw assetCacheError(code, error);
    } finally { operation = null; await updateStorage(); }
  }

  function pause() {
    if (operation) operation.paused = true;
    operation?.abort?.abort();
    stopWorker();
    if (operation) patch({ phase: 'paused', speedBps: 0, waiting: false, error: null });
  }
  const scan = (options = {}) => operation && !options.deep ? Promise.resolve(getState()) : perform('scan', { refresh: true, ...options });
  const manager = {
    getState, state: getState, initialize, scan,
    updateCatalog: () => perform('catalog-update'),
    downloadCatalog: () => perform('catalog-update'),
    setEmergency(value) {
      const emergency = !!value;
      if (state.emergency === emergency) return;
      patch({ emergency });
      if (emergency && (operation?.action === 'download' || operation?.action === 'catalog-update')) pause();
    },
    setRequirement(value) { if (typeof value === 'boolean' && state.requireAssetCache !== value) patch({ requireAssetCache: value }); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    downloadMissing: () => perform('download'),
    importZip(file) {
      if (!(file instanceof env.Blob)) return Promise.reject(assetCacheError('ASSET_CACHE_ZIP_INVALID'));
      return perform('import', { file });
    },
    importCatalog(file) {
      if (!(file instanceof env.Blob)) return Promise.reject(assetCacheError('ASSET_CACHE_BAD_CATALOG'));
      return perform('catalog', { file });
    },
    async admission({ fast = false } = {}) {
      // Fail open locally: optional mode remains usable when browser storage is unavailable.
      // Required mode is enforced by the server and refuses an absent/partial report.
      if (!state.supported) return null;
      if (fast && catalog && state.catalogCurrent && state.catalogComplete
        && state.missingFiles === 0 && state.readyFiles === state.totalFiles && state.readyBytes === state.totalBytes) {
        const report = { schema: catalog.schema, version: catalog.version,
          readyFiles: state.readyFiles, readyBytes: state.readyBytes };
        refreshAdmissionInBackground();
        return report;
      }
      if (fast) {
        // A cold or partial cache must be rejected by the server in strict mode, but the
        // create click itself must still reach the server immediately. Keep the expensive
        // recount off the request path so an optional room is never held behind storage I/O.
        refreshAdmissionInBackground();
        return null;
      }
      if (operation) return null;
      try {
        await scan({ refresh: true });
        if (!catalog || !state.catalogCurrent || !state.catalogComplete || operation) return null;
        return { schema: catalog.schema, version: catalog.version, readyFiles: state.readyFiles, readyBytes: state.readyBytes };
      } catch { return null; }
    },
    pause, clear: () => perform('clear'),
    requestPersistence() {
      if (!state.supported || !state.storage.persistenceSupported) {
        patch({ persistence: 'unsupported' });
        return Promise.resolve(false);
      }
      if (state.storage.persisted) {
        patch({ persistence: 'granted' });
        return Promise.resolve(true);
      }
      if (persistenceRequest) return persistenceRequest;

      // Invoke persist() before the first await so browsers retain the user activation.
      let pending;
      patch({ persistence: 'requesting' });
      try { pending = env.navigator.storage.persist(); }
      catch {
        patch({ persistence: 'error' });
        return Promise.resolve(false);
      }
      persistenceRequest = (async () => {
        try {
          const granted = !!await pending;
          await updateStorage();
          patch({ persistence: granted ? 'granted' : 'denied',
            storage: { ...state.storage, persisted: granted || state.storage.persisted } });
          return granted;
        } catch {
          await updateStorage();
          patch({ persistence: 'error' });
          return false;
        } finally { persistenceRequest = null; }
      })();
      return persistenceRequest;
    },
    async setPlaying(value) {
      if (ownPlaying === !!value) return;
      ownPlaying = !!value;
      patch({ playing: ownPlaying });
      if (ownPlaying) pause();
      if (registration) {
        try {
          const result = await swMessage('ASSET_CACHE_PLAYING', { playing: ownPlaying });
          patch({ playing: ownPlaying || !!result.playing });
        } catch { /* No SW must never prevent entering a match. */ }
      }
      if (!ownPlaying && !initialized && !initializing) await initialize();
      // Do not apply catalog upgrades on this page automatically: assets/data modules may still
      // hold old manifests. Explicit operations in the lobby or a normal reload adopt the new catalog.
    },
    destroy() {
      pause();
      if (backgroundTimer !== null) env.clearTimeout(backgroundTimer);
      env.navigator?.serviceWorker?.removeEventListener('message', onSWMessage);
      listeners.clear();
    },
  };
  return manager;
}

export const assetCache = createAssetCacheManager();
