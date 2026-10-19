import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { CACHING_CAPABLE_STRATEGIES } from '../../shared/constants.js';
import { resolvePathWithBase } from '../../shared/url.js';
import { openActive } from './store.js';
import { isManifestFile, matchRoute } from '../fetch/router.js';

/**
 * Determine if a URL should remain in any cache.
 *
 * A URL is "cacheable" if it is a precached/manifest app shell file,
 * or if the first matching route in config.routes uses a caching-capable strategy.
 *
 * @param {string} url  full URL string
 * @returns {boolean}
 */
export function isCacheableUrl(url) {
  const config = getConfig();
  const { routes, defaultStrategy } = config;

  let requestUrl;
  try {
    requestUrl = new URL(url);
  } catch {
    return false;
  }

  // Precached / manifest app shell files are always cacheable
  if (isManifestFile(requestUrl, config)) {
    return true;
  }

  const matchedRoute = matchRoute(requestUrl, routes, config);
  if (matchedRoute) {
    return CACHING_CAPABLE_STRATEGIES.has(matchedRoute.strategy);
  }

  const isSameOrigin = typeof self !== 'undefined' && self.location
    ? requestUrl.origin === self.location.origin
    : true;

  // Cross-origin requests without an explicit origin route pass through without caching
  if (!isSameOrigin) {
    return false;
  }

  // No route matched — fall back to defaultStrategy
  return CACHING_CAPABLE_STRATEGIES.has(defaultStrategy);
}

/**
 * Evict all entries from an opened Cache whose URLs are no longer cacheable
 * according to the current route config.
 *
 * @param {Cache}  cache
 * @param {string} cacheName  for logging
 * @param {Set<string>} protectedPaths  internal entries that must never be evicted
 *                                      (snapshot and runtime config.json)
 */
async function evictNonCacheable(cache, cacheName, protectedPaths) {
  const keys = await cache.keys();

  await Promise.all(
    keys.map(async (request) => {
      const { pathname } = new URL(request.url);

      // Never evict internal entries: the snapshot and the runtime config
      if (protectedPaths.has(pathname)) return;

      if (!isCacheableUrl(request.url)) {
        await cache.delete(request);
        logger.log(`[NLPWA] Evicted (route no longer cacheable) [${cacheName}]: ${pathname}`);
      }
    })
  );
}

/**
 * Run route-aware eviction on both offline and runtime caches.
 *
 * Called after every successful update to clean up entries whose routes
 * have been removed or changed to network-only in the latest config.
 */
export async function evictByRoute() {
  const { caches: cacheNames, snapshotCachePath, configPath, base } = getConfig();
  const rawConfigPath = configPath || '/config.json';
  const baseConfigPath = resolvePathWithBase(rawConfigPath, base);
  const protectedPaths = new Set(
    [snapshotCachePath, rawConfigPath, baseConfigPath].filter(Boolean)
  );

  const [offlineCache, runtimeCache] = await Promise.all([
    openActive(cacheNames.offline),
    caches.open(cacheNames.runtime),
  ]);

  await Promise.all([
    evictNonCacheable(offlineCache, cacheNames.offline, protectedPaths),
    evictNonCacheable(runtimeCache, cacheNames.runtime, protectedPaths),
  ]);
}
