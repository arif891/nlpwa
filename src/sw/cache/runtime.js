import { getConfig } from '../config/index.js';
import { openActive, getActive, getActiveName, resetMeta } from './store.js';
import { resolvePathWithBase } from '../../shared/url.js';

// ── Offline cache helpers ────────────────────────────────────────────────────

/**
 * Read a response from the offline (app shell) cache.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
export async function getFromOffline(request, matchOptions) {
  const { caches: cacheNames, retainPreviousVersionCache, base } = getConfig();
  const cache = await openActive(cacheNames.offline);
  let hit = await cache.match(request, matchOptions);

  if (!hit) {
    let pathname = null;
    try {
      pathname = new URL(typeof request === 'string' ? request : request.url, 'https://example.com').pathname;
    } catch {}
    if (pathname === '/') {
      hit = await cache.match('/index.html', matchOptions);
    } else if (pathname === '/index.html') {
      hit = await cache.match('/', matchOptions);
    } else if (base) {
      const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
      if (pathname === cleanBase || pathname === `${cleanBase}/`) {
        hit = (await cache.match(`${cleanBase}/index.html`, matchOptions))
          ?? (await cache.match('/index.html', matchOptions))
          ?? (await cache.match(cleanBase, matchOptions))
          ?? (await cache.match(`${cleanBase}/`, matchOptions));
      } else if (pathname === `${cleanBase}/index.html`) {
        hit = (await cache.match(`${cleanBase}/`, matchOptions))
          ?? (await cache.match(cleanBase, matchOptions))
          ?? (await cache.match('/index.html', matchOptions));
      }
    }
  }

  if (!hit && retainPreviousVersionCache) {
    const active = await getActive();
    if (active?.previousCache) {
      try {
        const prev = await caches.open(active.previousCache);
        hit = await prev.match(request, matchOptions);
        if (!hit) {
          let pathname = null;
          try {
            pathname = new URL(typeof request === 'string' ? request : request.url, 'https://example.com').pathname;
          } catch {}
          if (pathname === '/') {
            hit = await prev.match('/index.html', matchOptions);
          } else if (pathname === '/index.html') {
            hit = await prev.match('/', matchOptions);
          } else if (base) {
            const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
            if (pathname === cleanBase || pathname === `${cleanBase}/`) {
              hit = (await prev.match(`${cleanBase}/index.html`, matchOptions))
                ?? (await prev.match('/index.html', matchOptions))
                ?? (await prev.match(cleanBase, matchOptions))
                ?? (await prev.match(`${cleanBase}/`, matchOptions));
            } else if (pathname === `${cleanBase}/index.html`) {
              hit = (await prev.match(`${cleanBase}/`, matchOptions))
                ?? (await prev.match(cleanBase, matchOptions))
                ?? (await prev.match('/index.html', matchOptions));
            }
          }
        }
      } catch {
        // previous cache may have been removed
      }
    }
  }
  return hit;
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
      const isNullBody = [101, 204, 205, 304].includes(response.status);
      const headers = new Headers(response.headers);
      if (!headers.has('X-NLPWA-Cached-At')) {
        headers.set('X-NLPWA-Cached-At', String(Date.now()));
      }
      if (isNullBody) {
        headers.set('X-NLPWA-Content-Length', '0');
        responseToStore = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        await cache.put(request, responseToStore);
        return;
      }
      if (!headers.has('X-NLPWA-Content-Length')) {
        const cl = headers.get('Content-Length');
        if (cl) {
          headers.set('X-NLPWA-Content-Length', cl);
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
  const { caches: cacheNames, base } = getConfig();
  const cache = await caches.open(cacheNames.runtime);
  await Promise.all(
    paths.flatMap((path) => {
      const ops = [cache.delete(path)];
      if (base) {
        ops.push(cache.delete(resolvePathWithBase(path, base)));
      }
      return ops;
    })
  );
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
