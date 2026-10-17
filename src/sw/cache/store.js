/**
 * Tiny "meta" cache + helpers that make updates atomic.
 *
 *   nlpwa-meta
 *     /_nlpwa/active.json  → { cache, version, swVersion }   which offline cache is live
 *     /_nlpwa/staged.json  → { cache, version, swVersion, complete, retryCount, evict, ... }
 *
 * Each app version lives in its own offline cache (`offline@<version>-<id>`).
 * An update is built in a new cache while the active one keeps serving; the
 * switch is a single write to active.json. With no pointer yet (first run, or
 * an app installed by an older NLPWA) the plain `offline` cache is the active one.
 *
 * This module has no dependency on config so config/index.js can use it.
 */

export const META_CACHE = 'nlpwa-meta';
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
  if (!_activePromise) _activePromise = readMeta(ACTIVE_KEY);
  return _activePromise;
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

// ── Staged update record ──────────────────────────────────────────────────

export const getStaged = () => readMeta(STAGED_KEY);
export const setStaged = (record) => writeMeta(STAGED_KEY, record);
export const clearStaged = () => deleteMeta(STAGED_KEY);

/** Forget everything (used by clearAllCaches and tests). */
export async function resetMeta() {
  _activePromise = null;
  await Promise.all([deleteMeta(ACTIVE_KEY), deleteMeta(STAGED_KEY)]);
}

/** Drop the in-memory memo only (tests install a fresh CacheStorage per case). */
export function resetStoreMemo() {
  _activePromise = null;
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

// ── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Delete every offline cache that is neither in `keep` nor the runtime cache.
 * Managed names are the base name itself (legacy) and `<base>@…` (versioned).
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
