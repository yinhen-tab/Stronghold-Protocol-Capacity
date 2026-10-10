// Dedicated pre-cache downloads only. One budget covers every response, including clients behind different IPs.
// Token buckets account bytes accepted by node:http; round-robin is by client, then by that client's files.
import { performance } from 'node:perf_hooks';

export const ASSET_CACHE_LIMIT_DEFAULTS = Object.freeze({
  totalBps: 1_000_000, clientBps: 500_000, maxDownloads: 24, maxDownloadsPerClient: 2,
});

const QUANTUM = 8 * 1024;
const TICK_MS = 20;
const BURST_SECONDS = 0.1;
const IDLE_CLIENT_MS = 2_000;

function rate(value, fallback) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError('asset cache rate must be a non-negative integer');
  return parsed;
}

/** Bytes per second, not Mbps. A zero aggregate rate explicitly disables online filling. */
export function assetCacheLimitOptions(opts = {}, env = process.env) {
  const totalBps = rate(opts.totalBps ?? env.SP_ASSET_CACHE_TOTAL_BPS, ASSET_CACHE_LIMIT_DEFAULTS.totalBps);
  const clientBps = rate(opts.clientBps ?? env.SP_ASSET_CACHE_CLIENT_BPS, ASSET_CACHE_LIMIT_DEFAULTS.clientBps);
  if (totalBps > 0 && clientBps === 0) throw new RangeError('asset cache client rate must be positive when online filling is enabled');
  return { ...ASSET_CACHE_LIMIT_DEFAULTS, ...opts, totalBps, clientBps };
}

export class CacheDownloadLimiter {
  constructor(opts = {}) {
    this.opts = assetCacheLimitOptions(opts);
    for (const name of ['maxDownloads', 'maxDownloadsPerClient']) {
      if (!Number.isSafeInteger(this.opts[name]) || this.opts[name] < 1) throw new RangeError(`invalid asset cache ${name}`);
    }
    this.clients = new Map();
    this.active = 0;
    this.tokens = 0;
    this.updatedAt = performance.now();
    this.cursor = 0;
    this.timer = null;
    this.pumping = false;
    this.closed = false;
  }

  policy() {
    return { enabled: !this.closed && this.opts.totalBps > 0, totalBps: this.opts.totalBps,
      clientBps: this.opts.clientBps, maxDownloads: this.opts.maxDownloads,
      maxDownloadsPerClient: this.opts.maxDownloadsPerClient, activeDownloads: this.active };
  }

  /** Reserve before opening/hash-checking a file, bounding disk work as well as sockets. */
  acquire(key) {
    if (this.closed || this.opts.totalBps === 0 || this.active >= this.opts.maxDownloads) return null;
    const now = performance.now();
    this.prune(now);
    let client = this.clients.get(key);
    if (client && client.jobs.size >= this.opts.maxDownloadsPerClient) return null;
    if (!client) {
      client = { tokens: 0, updatedAt: now, idleAt: now, jobs: new Set(), cursor: 0 };
      this.clients.set(key, client);
    }
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const job = { client, handle: null, res: null, size: 0, position: 0, blocked: false, released: false,
      cleanup: null, resolve, done };
    client.jobs.add(job);
    this.active++;
    const release = () => this.release(job);
    return {
      release,
      get released() { return job.released; },
      stream: (handle, res, size) => {
        if (job.released) return done;
        job.handle = handle; job.res = res; job.size = size;
        const onClose = () => release();
        const onError = () => release();
        const onDrain = () => { job.blocked = false; this.schedule(); };
        res.once('close', onClose); res.once('error', onError); res.on('drain', onDrain);
        job.cleanup = () => { res.off('close', onClose); res.off('error', onError); res.off('drain', onDrain); };
        if (res.destroyed || res.writableEnded) release();
        else this.schedule();
        return done;
      },
    };
  }

  prune(now) {
    for (const [key, client] of this.clients) {
      if (!client.jobs.size && now - client.idleAt > IDLE_CLIENT_MS) this.clients.delete(key);
    }
  }

  release(job) {
    if (job.released) return;
    job.released = true;
    job.cleanup?.();
    job.client.jobs.delete(job);
    job.client.idleAt = performance.now();
    this.active--;
    job.resolve();
    if (!this.active && this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule() {
    if (this.closed || this.timer || this.pumping || !this.active) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, TICK_MS);
    this.timer.unref?.();
  }

  async pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const now = performance.now();
      this.tokens = Math.min(Math.max(1, this.opts.totalBps * BURST_SECONDS), this.tokens + (now - this.updatedAt) * this.opts.totalBps / 1000);
      this.updatedAt = now;
      const clients = [...this.clients.values()].filter((client) => client.jobs.size);
      for (const client of clients) {
        client.tokens = Math.min(Math.max(1, this.opts.clientBps * BURST_SECONDS), client.tokens + (now - client.updatedAt) * this.opts.clientBps / 1000);
        client.updatedAt = now;
      }
      let misses = 0;
      // No busy-spin when every client is capped/backpressured/preparing its file.
      while (!this.closed && this.tokens >= 1 && clients.length && misses < clients.length) {
        const client = clients[this.cursor++ % clients.length];
        const jobs = [...client.jobs];
        let job = null;
        for (let i = 0; i < jobs.length; i++) {
          const candidate = jobs[client.cursor++ % jobs.length];
          if (!candidate.released && candidate.handle && !candidate.blocked) { job = candidate; break; }
        }
        if (!job || client.tokens < 1) { misses++; continue; }
        const length = Math.floor(Math.min(QUANTUM, this.tokens, client.tokens, job.size - job.position));
        if (length <= 0) {
          if (job.position >= job.size) { job.res.end(); this.release(job); }
          else misses++;
          continue;
        }
        misses = 0;
        try {
          const buffer = Buffer.allocUnsafe(length);
          // The file is opened and verified by assetCache.js; at most one small disk read is pending here.
          const { bytesRead } = await job.handle.read(buffer, 0, length, job.position);
          if (job.released) continue;
          if (bytesRead !== length) throw new Error('asset cache file changed during transfer');
          this.tokens -= bytesRead; client.tokens -= bytesRead;
          job.position += bytesRead;
          job.blocked = !job.res.write(buffer.subarray(0, bytesRead));
          if (job.position === job.size) { job.res.end(); this.release(job); }
        } catch {
          job.res.destroy(); this.release(job);
        }
      }
    } finally { this.pumping = false; this.schedule(); }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const client of this.clients.values()) for (const job of [...client.jobs]) {
      job.res?.destroy(); this.release(job);
    }
    this.clients.clear();
  }
}
