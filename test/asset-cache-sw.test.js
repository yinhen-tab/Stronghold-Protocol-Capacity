import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../shared/assetCache.js';

const origin = 'https://game.test';
const body = new TextEncoder().encode('atlas bytes');
const sha256 = await helpers.sha256Hex(body);
const entry = { url: '/assets/model.atlas', bytes: body.length, sha256, type: 'text/plain', aliases: [] };
const catalog = { schema: 1, version: 'a'.repeat(64), files: [entry], totalFiles: 1, totalBytes: body.length,
  complete: true, missing: [], app: 'test' };
const source = (await fs.readFile(new URL('../public/asset-cache-sw.js', import.meta.url), 'utf8'))
  .replace(/import \{[\s\S]*?\} from '\/shared\/assetCache\.js';/, '');

async function fixture({ slowMetadata = false, blockPassive = false } = {}) {
  const handlers = new Map(), stores = new Map(), windows = new Map();
  let network = 0, locks = 0;
  const storage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const records = stores.get(name);
      return {
        async match(value) { return records.get(typeof value === 'string' ? value : value.url)?.response.clone(); },
        async put(value, response) {
          if (slowMetadata && name === helpers.ASSET_CACHE_META) await new Promise((resolve) => setTimeout(resolve, 2));
          const request = typeof value === 'string' ? new Request(value) : value.clone();
          records.set(request.url, { request, response: response.clone() });
        },
        async keys() { return [...records.values()].map((record) => record.request.clone()); },
        async delete(value) { return records.delete(typeof value === 'string' ? value : value.url); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
  const clients = { async matchAll() { return [...windows.values()]; }, async claim() {} };
  const self = { location: { origin }, clients, navigator: { locks: { async request(_name, _options, fn) {
    locks++; return fn(blockPassive ? null : {});
  } } }, addEventListener(name, callback) { handlers.set(name, callback); } };
  const context = vm.createContext({ ...helpers, self, caches: storage, fetch: async () => {
    network++;
    // Fetch returns decoded bytes, while Content-Length still describes the compressed wire body.
    return new Response(body, { headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': '7' } });
  }, Request, Response, Headers, URL, Uint8Array, crypto: globalThis.crypto, Date, Promise, Map, Set });
  vm.runInContext(source, context);
  const addClient = (id) => windows.set(id, { id, postMessage() {} });
  const message = (id, data) => new Promise((resolve, reject) => {
    handlers.get('message')({ source: windows.get(id), data, ports: [{ postMessage: resolve }],
      waitUntil(promise) { promise.catch(reject); } });
  });
  const fetchFile = async (id) => {
    const waits = []; let result;
    handlers.get('fetch')({ clientId: id, request: new Request(origin + entry.url),
      respondWith(promise) { result = promise; }, waitUntil(promise) { waits.push(promise); } });
    const response = await result;
    await Promise.all(waits);
    return response;
  };
  return { addClient, message, fetchFile, storage, network: () => network, locks: () => locks };
}

test('SW uses the ordinary network until this document pins its own catalog, even if old verified cache exists', async () => {
  const f = await fixture(); f.addClient('old'); f.addClient('new');
  await f.message('old', { type: 'ASSET_CACHE_PIN', catalog });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response('old-cache!!', { headers: helpers.validatedCacheHeaders(entry) }));
  assert.equal(await (await f.fetchFile('new')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'new document must not inherit the old page catalog');
  assert.equal(await (await f.fetchFile('old')).text(), 'old-cache!!');
  assert.equal(f.network(), 1);
});

test('SW passive caching verifies decoded gzip bytes and respects the shared mutation lock', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1); assert.equal(f.locks(), 1);
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'gzip body was validated and cached locally');
  const blocked = await fixture({ blockPassive: true }); blocked.addClient('page');
  await blocked.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  await blocked.fetchFile('page'); await blocked.fetchFile('page');
  assert.equal(blocked.network(), 2, 'clear/import/deep scan lock prevents competing passive writes');
});

test('SW serializes pin/playing writes and never lets a late same-version pin clear the live match flag', async () => {
  const f = await fixture({ slowMetadata: true }); f.addClient('page');
  const pinned = f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false });
  const entered = f.message('page', { type: 'ASSET_CACHE_PLAYING', playing: true });
  assert.equal((await pinned).ok, true); assert.equal((await entered).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false })).ok, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CAN_MUTATE' })).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CLEAR' })).error, 'ASSET_CACHE_PLAYING');
});
