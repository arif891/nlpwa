import { getConfig } from '../config/index.js';
import { openActive, getActiveName, resetMeta } from './store.js';

// ── Offline cache helpers ────────────────────────────────────────────────────

/**
 * Read a response from the offline (app shell) cache.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
export async function getFromOffline(request, matchOptions) {
  const { caches: cacheNames } = getConfig();
  const cache = await openActive(cacheNames.offline);
  return cache.match(request, matchOptions);
}

/**
 * Write a response into the offline cache.
 * Used by the update system to store fresh file fetches.
 *
 * @param {Request|string} request
 * @param {Response} response
 */
export async function putInOffline(request, response) {
  const { caches: cacheNames } = getConfig();
  const cache = await openActive(cacheNames.offline);
  await cache.put(request, response.clone());
}

/**
 * Delete a URL from the offline cache.
 *
 * @param {Request|string} request
 */
export async function deleteFromOffline(request) {
  const { caches: cacheNames } = getConfig();
  const cache = await openActive(cacheNames.offline);
  await cache.delete(request);
}

// ── Runtime cache helpers ────────────────────────────────────────────────────

/**
 * Read a response from the runtime (lazy) cache.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
export async function getFromRuntime(request, matchOptions) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.runtime);
  return cache.match(request, matchOptions);
}

/**
 * Write a response into the runtime cache.
 * Used by fetch strategies (network-first, stale-while-revalidate, cache-first).
 *
 * @param {Request|string} request
 * @param {Response} response
 */
export async function putInRuntime(request, response) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.runtime);

  let responseToStore = response.clone();
  if (response.type !== 'opaque') {
    try {
      const headers = new Headers(response.headers);
      if (!headers.has('X-NLPWA-Cached-At')) {
        headers.set('X-NLPWA-Cached-At', String(Date.now()));
      }
      if (!headers.has('X-NLPWA-Content-Length')) {
        const cl = headers.get('Content-Length');
        if (cl) {
          headers.set('X-NLPWA-Content-Length', cl);
        } else {
          try {
            const buf = await response.clone().arrayBuffer();
            headers.set('X-NLPWA-Content-Length', String(buf.byteLength));
            responseToStore = new Response(buf, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
            await cache.put(request, responseToStore);
            return;
          } catch {
            // fallback
          }
        }
      }
      responseToStore = new Response(responseToStore.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      responseToStore = response.clone();
    }
  }

  await cache.put(request, responseToStore);
}

/**
 * Delete specific URLs from the runtime cache.
 * Used during update to evict stale/changed files so they are re-fetched fresh.
 *
 * @param {string[]} paths  URL pathnames to evict, e.g. ['/app.js', '/pages/about.html']
 */
export async function evictFromRuntime(paths) {
  if (!paths.length) return;
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.runtime);
  await Promise.all(paths.map(path => cache.delete(path)));
}

/**
 * Delete the active offline cache and the runtime cache entirely.
 *
 * Called when swVersion changes — the developer has changed SW logic
 * (routes, strategies, precache list), so all existing cached data
 * is considered stale and must be fully rebuilt from the server manifest.
 */
export async function clearAllCaches() {
  const { caches: cacheNames } = getConfig();
  const activeName = await getActiveName(cacheNames.offline);
  await Promise.all([
    caches.delete(activeName),
    caches.delete(cacheNames.runtime),
  ]);
  await resetMeta();
  console.log('[NLPWA] All caches cleared (SW version change)');
}

/**
 * Convenience: look up a request from offline first, then runtime.
 * Returns the first match found, or undefined if neither has it.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
export async function getFromCache(request, matchOptions) {
  return (await getFromOffline(request, matchOptions)) ?? (await getFromRuntime(request, matchOptions));
}
