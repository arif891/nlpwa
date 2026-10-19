// Minimal in-memory stand-ins for CacheStorage / fetch so SW modules can run in Node.
import { initConfig } from '../../src/sw/config/index.js';
import { resetStoreMemo } from '../../src/sw/cache/store.js';
import { resetManifestMemo } from '../../src/sw/update/manifest.js';

function keyOf(req) {
  return typeof req === 'string' ? new URL(req, 'https://example.com').href : req.url;
}

class FakeCache {
  constructor() { this.map = new Map(); }
  async match(req, opts = {}) {
    const key = keyOf(req);
    if (this.map.has(key)) return this.map.get(key).clone();
    if (opts.ignoreSearch) {
      const base = new URL(key); base.search = '';
      for (const [k, v] of this.map) {
        const u = new URL(k); u.search = '';
        if (u.href === base.href) return v.clone();
      }
    }
    return undefined;
  }
  async put(req, res) { this.map.set(keyOf(req), res.clone()); }
  async add(req) {
    const res = await globalThis.fetch(req);
    if (!res.ok) throw new TypeError(`Cache.add failed: HTTP ${res.status}`);
    await this.put(req, res);
  }
  async delete(req) { return this.map.delete(keyOf(req)); }
  async keys() { return [...this.map.keys()].map(u => new Request(u)); }
}

class FakeCacheStorage {
  constructor() { this.stores = new Map(); }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async delete(name) { return this.stores.delete(name); }
  async keys() { return [...this.stores.keys()]; }
}

/**
 * Install fakes on globalThis and (re)initialise config.
 * @param {(req: Request|string) => Promise<Response>|Response} fetchImpl
 * @param {Object} [config]
 */
export function setupEnv(fetchImpl, config = {}) {
  globalThis.caches = new FakeCacheStorage();
  resetStoreMemo();
  resetManifestMemo();
  const existingClients = globalThis.self?.clients;
  globalThis.self = {
    location: { origin: 'https://example.com', href: 'https://example.com/sw.js' },
    ...(existingClients ? { clients: existingClients } : {}),
  };
  // Normalise relative strings to absolute Requests, like a real SW fetch would
  globalThis.fetch = async (req, init) =>
    fetchImpl(typeof req === 'string' ? new Request(new URL(req, 'https://example.com').href, init) : req, init);
  initConfig({ version: '1', routes: [], precache: [], ...config });
  return globalThis.caches;
}

export const req = (path, init) => new Request(new URL(path, 'https://example.com').href, init);
export const fakeEvent = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.allSettled(pending) };
};
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
