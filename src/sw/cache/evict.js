import { getConfig } from '../config/index.js';
import { matchGlob } from '../../shared/glob.js';
import { CACHING_CAPABLE_STRATEGIES } from '../../shared/constants.js';
import { openActive } from './store.js';

/**
 * Determine if a URL should remain in any cache.
 *
 * A URL is "cacheable" if the first matching route in config.routes uses
 * a caching-capable strategy (cache-first, network-first, stale-while-revalidate,
 * or cache-only). network-only routes are not cacheable.
 *
 * If no route matches, the defaultStrategy is used as the fallback.
 *
 * @param {string} url  full URL string
 * @returns {boolean}
 */
export function isCacheableUrl(url) {
  const { routes, defaultStrategy } = getConfig();

  let requestUrl;
  try {
    requestUrl = new URL(url);
  } catch {
    return false;
  }

  const isSameOrigin = typeof self !== 'undefined' && self.location
    ? requestUrl.origin === self.location.origin
    : true;

  for (const route of routes) {
    let routeOrigin = route.origin;
    let matchPattern = route.match;

    if (!routeOrigin && (matchPattern.startsWith('http://') || matchPattern.startsWith('https://'))) {
      try {
        routeOrigin = new URL(matchPattern.replace(/\*/g, 'x')).origin;
      } catch {
        // fallback
      }
    }

    if (routeOrigin) {
      if (routeOrigin !== '*' && routeOrigin !== requestUrl.origin) {
        continue;
      }
    } else if (!isSameOrigin) {
      // Unspecified origin matches ONLY same-origin requests
      continue;
    }

    if (matchGlob(matchPattern, requestUrl.href) || matchGlob(matchPattern, requestUrl.pathname)) {
      return CACHING_CAPABLE_STRATEGIES.has(route.strategy);
    }
  }

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
        console.log(`[NLPWA] Evicted (route no longer cacheable) [${cacheName}]: ${pathname}`);
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
  const { caches: cacheNames, manifestCachePath, snapshotCachePath, configPath } = getConfig();
  const protectedPaths = new Set(
    [manifestCachePath, snapshotCachePath, configPath || '/config.json'].filter(Boolean)
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
