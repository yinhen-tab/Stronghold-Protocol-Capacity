import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetCacheManager } from '../public/js/assetCache.js';

const catalog = { schema: 1, version: 'a'.repeat(64), files: [{ url: '/assets/a.png', bytes: 3,
  sha256: 'b'.repeat(64), type: 'image/png', aliases: [] }], totalFiles: 1, totalBytes: 3, complete: true, missing: [] };

function fixture({ storage = {}, secure = true } = {}) {
  const messages = [], work = [], listeners = new Map();
  let catalogReads = 0, broken = false, playing = false;
  const sw = { postMessage(data, ports) {
    messages.push(data);
    if (data.type === 'ASSET_CACHE_PLAYING') playing = data.playing;
    ports[0].postMessage({ ok: true, playing });
  } };
  const registration = { active: sw };
  const environment = {
    isSecureContext: secure, caches: {}, crypto: globalThis.crypto, Blob, MessageChannel, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1000 ? 1 : ms), clearTimeout,
    navigator: {
      serviceWorker: { controller: sw, ready: Promise.resolve(registration),
        register: async () => registration, addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name) },
      locks: { request: async (_name, _options, fn) => fn({}) },
      storage: { estimate: async () => ({ usage: 1, quota: 1000 }), persisted: async () => false, ...storage },
    },
    Worker: class {
      postMessage(message) {
        work.push(message);
        setTimeout(() => {
          this.onmessage?.({ data: { id: message.id, type: 'progress', readyFiles: 0, readyBytes: 0, missingFiles: 1, missingBytes: 3 } });
          this.onmessage?.({ data: { id: message.id, type: 'done' } });
        }, 0);
      }
      terminate() { this.onmessage = null; }
    },
  };
  const manager = createAssetCacheManager({ environment, doFetch: async (url) => {
    if (url.includes('catalog')) { catalogReads++; return Response.json(broken ? {} : catalog); }
    return Response.json({ policy: { enabled: false } });
  } });
  return { manager, messages, work, catalogReads: () => catalogReads, broken: (value) => { broken = value; },
    update: () => listeners.get('message')?.({ data: { type: 'ASSET_CACHE_UPDATED' } }) };
}

test('manager initialization errors are retryable and explicit reopens refresh the catalog', async () => {
  const f = fixture();
  try {
    f.broken(true);
    assert.equal((await f.manager.initialize()).error, 'ASSET_CACHE_BAD_CATALOG');
    f.broken(false);
    assert.equal((await f.manager.initialize()).phase, 'idle');
    assert.equal(f.catalogReads(), 2);
    await f.manager.initialize();
    assert.equal(f.catalogReads(), 3, 'explicit reopen adopts changes and checks actual cache');
    assert.equal(f.manager.getState().policy.enabled, false, 'disabled online filling still leaves local import available');
  } finally { f.manager.destroy(); }
});

test('a reconnect already in combat installs its playing guard without adopting a new catalog; lobby return retries', async () => {
  const f = fixture();
  try {
    await f.manager.setPlaying(true);
    assert.equal((await f.manager.initialize()).phase, 'paused');
    assert.equal(f.catalogReads(), 0);
    assert.equal(f.messages.filter((m) => m.type === 'ASSET_CACHE_PLAYING').at(-1).playing, true);
    await f.manager.setPlaying(false);
    assert.equal(f.manager.getState().phase, 'idle'); assert.equal(f.catalogReads(), 1);
    const before = f.messages.length;
    await f.manager.setPlaying(false); await f.manager.setPlaying(false);
    assert.equal(f.messages.length, before, 'high-frequency store emits do not rewrite the playing pin');
  } finally { f.manager.destroy(); }
});

test('passive asset progress notifications inspect local keys without repeatedly downloading the catalog', async () => {
  const f = fixture();
  try {
    await f.manager.initialize();
    f.update(); f.update();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.catalogReads(), 1);
    assert.equal(f.work.filter((job) => job.action === 'scan').length, 2, 'notifications are coalesced into one local scan');
  } finally { f.manager.destroy(); }
});

test('persistence invokes the API during the click and reports the granted storage state', async () => {
  let granted = false, calls = 0;
  const f = fixture({ storage: { persist() { calls++; granted = true; return Promise.resolve(true); },
    persisted: async () => granted } });
  const changes = [];
  f.manager.subscribe((state) => changes.push(state.persistence));
  try {
    assert.equal(f.manager.getState().storage.persistenceSupported, true);
    const pending = f.manager.requestPersistence();
    assert.equal(calls, 1, 'persist() must run before requestPersistence() returns to retain user activation');
    assert.equal(f.manager.getState().persistence, 'requesting');
    assert.equal(await pending, true);
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.persistenceSupported, true, 'storage refresh keeps API availability');
    assert.deepEqual([changes[0], changes.at(-1)], ['requesting', 'granted']);
    assert.equal(f.catalogReads(), 0, 'requesting persistence does not start cache initialization');
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(calls, 1, 'already persisted storage does not ask the browser again');
  } finally { f.manager.destroy(); }
});

test('browser refusal is visible, leaves cache operations usable, and allows a later request', async () => {
  let granted = false;
  const f = fixture({ storage: { persist: async () => granted, persisted: async () => granted } });
  try {
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'denied');
    assert.equal(f.manager.getState().phase, 'idle');
    assert.equal(f.manager.getState().error, null);
    assert.equal(f.manager.getState().storage.persisted, false);
    granted = true;
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().persistence, 'granted');
  } finally { f.manager.destroy(); }
});

test('missing persistence API is reported as unsupported, while cache support remains available', async () => {
  const f = fixture();
  try {
    assert.equal(f.manager.getState().supported, true);
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'unsupported');
    assert.equal((await f.manager.initialize()).phase, 'idle');
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
  } finally { f.manager.destroy(); }
});

test('insecure context prevents invoking persistence even if the API exists', async () => {
  let calls = 0;
  const f = fixture({ secure: false, storage: { persist() { calls++; return true; } } });
  try {
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'unsupported');
    assert.equal(calls, 0);
  } finally { f.manager.destroy(); }
});

test('persistence exceptions are visible and a rejection does not poison the next request', async () => {
  for (const synchronous of [true, false]) {
    let fails = true;
    const f = fixture({ storage: { persist() {
      if (!fails) return false;
      if (synchronous) throw new Error('unavailable');
      return Promise.reject(new Error('unavailable'));
    } } });
    try {
      assert.equal(await f.manager.requestPersistence(), false);
      assert.equal(f.manager.getState().persistence, 'error');
      assert.equal(f.manager.getState().error, null);
      fails = false;
      assert.equal(await f.manager.requestPersistence(), false);
      assert.equal(f.manager.getState().persistence, 'denied');
    } finally { f.manager.destroy(); }
  }
});

test('concurrent persistence requests share one pending browser prompt', async () => {
  let finish, calls = 0;
  const f = fixture({ storage: { persist() { calls++; return new Promise((resolve) => { finish = resolve; }); } } });
  try {
    const first = f.manager.requestPersistence();
    const second = f.manager.requestPersistence();
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(f.manager.getState().persistence, 'requesting');
    finish(false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(f.manager.getState().persistence, 'denied');
  } finally { f.manager.destroy(); }
});

test('quota inspection failure does not hide a granted persistence request', async () => {
  let persistedReads = 0;
  const f = fixture({ storage: { persist: async () => true,
    estimate: async () => { throw new Error('quota unavailable'); },
    persisted: async () => { persistedReads++; return true; } } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(persistedReads, 1, 'persistence inspection still runs when quota inspection fails');
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 0);
  } finally { f.manager.destroy(); }
});

test('persist permission is retained without persisted inspection support', async () => {
  const f = fixture({ storage: { persist: async () => true, persisted: undefined } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 1000);
    await f.manager.initialize();
    assert.equal(f.manager.getState().storage.persisted, true, 'subsequent quota refresh cannot erase the granted permission');
  } finally { f.manager.destroy(); }
});

test('persistence inspection failure does not hide quota estimates or erase granted permission', async () => {
  const f = fixture({ storage: { persist: async () => true,
    persisted: async () => { throw new Error('inspection unavailable'); } } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 1000);
    await f.manager.initialize();
    assert.equal(f.manager.getState().storage.persisted, true);
  } finally { f.manager.destroy(); }
});
