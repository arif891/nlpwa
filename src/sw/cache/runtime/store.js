import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { getActiveName, resetMeta } from '../meta/index.js';
import { resolvePathWithBase } from '../../../shared/url.js';
import { cleanTrackingParams } from '../keys.js';
import { matchWithAliases } from '../offline/aliases.js';
import { getFromOffline } from '../offline/store.js';

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
      const rawUrl = typeof request === 'string' ? request : request.url;
      const cleanedUrl = cleanTrackingParams(rawUrl, ignoreURLParametersMatching);
      let keyToStore = request;
      if (cleanedUrl !== rawUrl) {
        if (typeof request === 'string') {
          keyToStore = cleanedUrl;
        } else {
          try {
            keyToStore = new Request(cleanedUrl, request);
          } catch {
            keyToStore = cleanedUrl;
          }
        }
      }

      if (isNullBody) {
        headers.set('X-NLPWA-Content-Length', '0');
        responseToStore = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        await cache.put(keyToStore, responseToStore);
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
      await cache.put(keyToStore, responseToStore);
      return;
    } catch {
      responseToStore = response.clone();
    }
  }

  const rawUrl = typeof request === 'string' ? request : request.url;
  const cleanedUrl = cleanTrackingParams(rawUrl, ignoreURLParametersMatching);
  let keyToStore = request;
  if (cleanedUrl !== rawUrl) {
    if (typeof request === 'string') {
      keyToStore = cleanedUrl;
    } else {
      try {
        keyToStore = new Request(cleanedUrl, request);
      } catch {
        keyToStore = cleanedUrl;
      }
    }
  }
  await cache.put(keyToStore, responseToStore);
}

/**
 * Delete specific URLs from the runtime cache.
 * Used during update to evict stale/changed files so they are re-fetched fresh.
 *
 * @param {string[]} paths URL pathnames to evict, e.g. ['/app.js', '/pages/about.html']
 */
export async function evictFromRuntime(paths) {
  if (!paths || !paths.length) return;
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
 * Clear the entire runtime cache.
 *
 * @returns {Promise<boolean>}
 */
export async function clearRuntimeCache() {
  const { caches: cacheNames } = getConfig();
  logger.log(`[NLPWA] Cleared cache: ${cacheNames.runtime}`);
  return caches.delete(cacheNames.runtime);
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
 * @param {CacheQueryOptions} [matchOptions]
 * @param {string|null} [clientId]
 * @returns {Promise<Response|undefined>}
 */
export async function getFromCache(request, matchOptions, clientId = null) {
  return (await getFromOffline(request, matchOptions, clientId)) ?? (await getFromRuntime(request, matchOptions));
}
