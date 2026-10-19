import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { openActive, getActive, getActiveName, getClientPinnedCache, resetMeta } from './store.js';
import { resolvePathWithBase } from '../../shared/url.js';
import { cleanTrackingParams } from './keys.js';

// ── Offline cache helpers ────────────────────────────────────────────────────

/**
 * Match a request against a cache with standard HTML, clean URLs, directory index, and base path aliases.
 *
 * @param {Cache} cache
 * @param {Request|string} request
 * @param {CacheQueryOptions} [matchOptions]
 * @param {string} [base]
 * @param {Object} [config]
 * @returns {Promise<Response|undefined>}
 */
export async function matchWithAliases(cache, request, matchOptions, base, config = getConfig()) {
  const rawUrl = typeof request === 'string' ? request : request.url;
  const ignorePatterns = config?.ignoreURLParametersMatching;
  const cleanedUrl = cleanTrackingParams(rawUrl, ignorePatterns);

  let hit;
  if (cleanedUrl !== rawUrl) {
    hit = await cache.match(cleanedUrl, matchOptions);
    if (!hit) {
      hit = await cache.match(request, matchOptions);
    }
  } else {
    hit = await cache.match(request, matchOptions);
  }
  if (hit) return hit;

  let pathname = null;
  try {
    pathname = new URL(cleanedUrl, 'https://example.com').pathname;
  } catch {}

  if (!pathname) return undefined;

  const directoryIndex = config?.directoryIndex ?? 'index.html';
  const cleanIndex = directoryIndex.startsWith('/') ? directoryIndex.slice(1) : directoryIndex;
  const cleanURLs = config?.cleanURLs !== false;

  // 1. Root / Directory index
  if (directoryIndex) {
    if (pathname === '/') {
      hit = await cache.match(`/${cleanIndex}`, matchOptions);
      if (hit) return hit;
    } else if (pathname === `/${cleanIndex}`) {
      hit = await cache.match('/', matchOptions);
      if (hit) return hit;
    } else if (pathname.endsWith('/')) {
      hit = await cache.match(`${pathname}${cleanIndex}`, matchOptions);
      if (hit) return hit;
    }
  }

  // 2. Clean URLs (e.g. /about -> /about.html)
  if (cleanURLs) {
    const lastSegment = pathname.split('/').pop() || '';
    if (lastSegment && !lastSegment.includes('.')) {
      hit = await cache.match(`${pathname}.html`, matchOptions);
      if (hit) return hit;
    }
  }

  // 3. Subpath base aliases
  if (base) {
    const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
    if (pathname === cleanBase || pathname === `${cleanBase}/`) {
      return (await cache.match(`${cleanBase}/${cleanIndex}`, matchOptions))
        ?? (await cache.match(`/${cleanIndex}`, matchOptions))
        ?? (await cache.match(cleanBase, matchOptions))
        ?? (await cache.match(`${cleanBase}/`, matchOptions));
    }
    if (pathname === `${cleanBase}/${cleanIndex}`) {
      return (await cache.match(`${cleanBase}/`, matchOptions))
        ?? (await cache.match(cleanBase, matchOptions))
        ?? (await cache.match(`/${cleanIndex}`, matchOptions));
    }
  }
  return undefined;
}

/**
 * Read a response from the offline (app shell) cache.
 *
 * @param {Request|string} request
 * @param {CacheQueryOptions} [matchOptions]
 * @returns {Promise<Response|undefined>}
 */
export async function getFromOffline(request, matchOptions, clientId = null) {
  const config = getConfig();
  const { caches: cacheNames, retainPreviousVersionCache, base } = config;

  let cache;
  const pinnedName = clientId ? getClientPinnedCache(clientId) : null;
  if (pinnedName) {
    try {
      cache = await caches.open(pinnedName);
    } catch {
      cache = await openActive(cacheNames.offline);
    }
  } else {
    cache = await openActive(cacheNames.offline);
  }

  let hit = await matchWithAliases(cache, request, matchOptions, base, config);

  if (!hit && retainPreviousVersionCache) {
    const active = await getActive();
    if (active?.previousCache && active.previousCache !== pinnedName) {
      try {
        const prev = await caches.open(active.previousCache);
        hit = await matchWithAliases(prev, request, matchOptions, base, config);
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
 * @param {CacheQueryOptions} [matchOptions]
 * @returns {Promise<Response|undefined>}
 */
export async function getFromRuntime(request, matchOptions) {
  const config = getConfig();
  const { caches: cacheNames, base } = config;
  const cache = await caches.open(cacheNames.runtime);
  return matchWithAliases(cache, request, matchOptions, base, config);
}

/**
 * Write a response into the runtime cache.
 * Used by fetch strategies (network-first, stale-while-revalidate, cache-first).
 *
 * @param {Request|string} request
 * @param {Response} response
 */
export async function putInRuntime(request, response) {
  const config = getConfig();
  const { caches: cacheNames, ignoreURLParametersMatching } = config;
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

  const rawUrl = typeof request === 'string' ? request : request.url;
  const cleanedUrl = cleanTrackingParams(rawUrl, ignoreURLParametersMatching);
  const keyToStore = cleanedUrl !== rawUrl ? cleanedUrl : request;
  await cache.put(keyToStore, responseToStore);
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
  logger.log('[NLPWA] All caches cleared (SW version change)');
}

/**
 * Convenience: look up a request from offline first, then runtime.
 * Returns the first match found, or undefined if neither has it.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
export async function getFromCache(request, matchOptions, clientId = null) {
  return (await getFromOffline(request, matchOptions, clientId)) ?? (await getFromRuntime(request, matchOptions));
}
