/**
 * Tiny "meta" cache + helpers that make updates atomic.
 *
 *   nlpwa-meta
 *     /_nlpwa/active.json  → { cache, version, swVersion }   which offline cache is live
 *     /_nlpwa/staged.json  → { cache, version, swVersion, complete, retryCount, evict, ... }
 *
 * Each app version lives in its own offline cache (`offline@<version>-<id>`).
 * An update is built in a new cache while the active one keeps serving; the
 * switch is a single atomic write to active.json.
 *
 * This module has no dependency on config so config/index.js can use it.
 */

export let META_CACHE = 'nlpwa-meta';

/**
 * Get current meta cache name.
 * @returns {string}
 */
export function getMetaCacheName() {
  return META_CACHE;
}

/**
 * Configure the meta cache name (invoked during initConfig).
 * @param {string} name
 */
export function setMetaCacheName(name) {
  if (name && typeof name === 'string') {
    META_CACHE = name;
  }
}

const ACTIVE_KEY = '/_nlpwa/active.json';
const STAGED_KEY = '/_nlpwa/staged.json';

async function readMeta(key) {
  const cache = await caches.open(META_CACHE);
  const response = await cache.match(key);
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function writeMeta(key, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(key, new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function deleteMeta(key) {
  const cache = await caches.open(META_CACHE);
  await cache.delete(key);
}

// ── Active pointer (memoised: the SW can be restarted at any time, so the
//    first read always comes from the meta cache) ─────────────────────────

let _activePromise = null;

export function getActive() {
  if (!_activePromise) {
    _activePromise = (async () => {
      const record = await readMeta(ACTIVE_KEY).catch(() => null);
      if (!record || !record.cache) return null;

      // Pointer-validity check: verify that the cache referenced actually exists in CacheStorage
      // and is non-empty. If the browser evicted it, discard the stale pointer.
      try {
        if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
          const names = await caches.keys();
          if (!names.includes(record.cache)) {
            console.warn(`[NLPWA] Active cache "${record.cache}" was evicted by the browser. Clearing stale active pointer.`);
            await deleteMeta(ACTIVE_KEY);
            return null;
          }
          const cache = await caches.open(record.cache);
          const keys = await cache.keys();
          if (keys.length === 0) {
            console.warn(`[NLPWA] Active cache "${record.cache}" is empty (likely evicted by the browser). Clearing stale active pointer.`);
            await deleteMeta(ACTIVE_KEY);
            return null;
          }
          if (record.previousCache && !names.includes(record.previousCache)) {
            delete record.previousCache;
            await writeMeta(ACTIVE_KEY, record);
          }
        }
      } catch (err) {
        console.warn('[NLPWA] Could not verify active cache validity:', err?.message || err);
      }
      return record;
    })().catch(() => {
      _activePromise = null;
      return null;
    });
  }
  return _activePromise;
}

export async function clearActive() {
  await deleteMeta(ACTIVE_KEY);
  _activePromise = Promise.resolve(null);
}

export async function getActiveName(baseName) {
  return (await getActive())?.cache ?? baseName;
}

export async function openActive(baseName) {
  return caches.open(await getActiveName(baseName));
}

/** The single atomic commit point of an update. */
export async function setActive(record) {
  await writeMeta(ACTIVE_KEY, record);
  _activePromise = Promise.resolve(record);
}

// ── Staged update record (memoised to eliminate redundant CacheStorage reads) ─

let _stagedPromise = null;

export function getStaged() {
  if (!_stagedPromise) {
    _stagedPromise = readMeta(STAGED_KEY).catch(() => {
      _stagedPromise = null;
      return null;
    });
  }
  return _stagedPromise;
}

export async function setStaged(record) {
  await writeMeta(STAGED_KEY, record);
  _stagedPromise = Promise.resolve(record);
}

export async function clearStaged() {
  await deleteMeta(STAGED_KEY);
  _stagedPromise = Promise.resolve(null);
}

/** Forget everything (used by clearAllCaches and tests). */
export async function resetMeta() {
  _activePromise = null;
  _stagedPromise = null;
  await Promise.all([deleteMeta(ACTIVE_KEY), deleteMeta(STAGED_KEY)]);
}

/** Drop the in-memory memo only (tests install a fresh CacheStorage per case). */
export function resetStoreMemo() {
  _activePromise = null;
  _stagedPromise = null;
  _busy = false;
}

// ── Cooperative lock ──────────────────────────────────────────────────────
// Staging and committing must not overlap. Navigations must never wait for a
// long download, so callers use tryAcquire() and simply skip when busy.

let _busy = false;

export function tryAcquire() {
  if (_busy) return false;
  _busy = true;
  return true;
}

export function release() {
  _busy = false;
}

/**
 * Execute an operation under the NLPWA operation lock.
 * Uses navigator.locks.request with ifAvailable: true across worker instances,
 * falling back to tryAcquire / release in memory.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {T|(() => T)} [fallback=false]
 * @returns {Promise<T>}
 */
export async function withLock(fn, fallback = false) {
  const getFallback = () => (typeof fallback === 'function' ? fallback() : fallback);

  const nav = typeof navigator !== 'undefined'
    ? navigator
    : typeof self !== 'undefined'
      ? self.navigator
      : null;

  if (nav?.locks?.request && typeof nav.locks.request === 'function') {
    try {
      return await nav.locks.request('nlpwa-operation-lock', { ifAvailable: true }, async (lock) => {
        if (!lock) return getFallback();
        if (!tryAcquire()) return getFallback();
        try {
          return await fn();
        } finally {
          release();
        }
      });
    } catch {
      // Fall through to in-memory locking if Web Locks throws or is unsupported
    }
  }

  if (!tryAcquire()) return getFallback();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Delete every offline cache that is neither in `keep` nor the runtime cache.
 * Managed names are the unversioned base cache (`base`) and versioned caches (`<base>@…`).
 *
 * @param {{ base: string, runtime: string, keep: Array<string|undefined> }} opts
 */
export async function cleanupCaches({ base, runtime, keep }) {
  const keepSet = new Set(keep.filter(Boolean));
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name !== runtime && name !== META_CACHE && !keepSet.has(name))
      .filter((name) => name === base || name.startsWith(`${base}@`))
      .map((name) => {
        console.log(`[NLPWA] Removed old cache: ${name}`);
        return caches.delete(name);
      })
  );
}
