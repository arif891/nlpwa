import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { CACHING_CAPABLE_STRATEGIES } from '../../../shared/constants.js';
import { resolvePathWithBase } from '../../../shared/url.js';
import { openActive } from '../meta/index.js';
import { isManifestFile, matchRoute } from '../../fetch/router.js';

/**
 * Determine if a URL should remain in any cache.
 *
 * @param {string} url full URL string
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
 * @param {Cache} cache
 * @param {string} cacheName
 * @param {Set<string>} protectedPaths
 */
async function evictNonCacheable(cache, cacheName, protectedPaths) {
  const requests = await cache.keys();
  let evicted = 0;

  for (const req of requests) {
    let pathname;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      pathname = null;
    }

    if (pathname && protectedPaths.has(pathname)) {
      continue;
    }

    if (!isCacheableUrl(req.url)) {
      await cache.delete(req);
      evicted++;
      logger.log(`[NLPWA] Evicted non-cacheable route entry: ${req.url} (cache: ${cacheName})`);
    }
  }

  return evicted;
}

/**
 * Run route-based eviction across both the active offline cache and the runtime cache.
 *
 * @returns {Promise<{ offlineEvicted: number, runtimeEvicted: number }>}
 */
export async function evictByRoute() {
  const config = getConfig();
  const { caches: cacheNames, configPath = '/config.json', base } = config;

  const normalizedConfigPath = resolvePathWithBase(configPath, base);
  const protectedPaths = new Set([
    '/_nlpwa/snapshot.json',
    normalizedConfigPath,
    configPath,
  ]);

  let offlineEvicted = 0;
  try {
    const offlineCache = await openActive(cacheNames.offline);
    offlineEvicted = await evictNonCacheable(offlineCache, cacheNames.offline, protectedPaths);
  } catch (err) {
    logger.warn('[NLPWA] Route-based eviction failed for offline cache:', err?.message || err);
  }

  let runtimeEvicted = 0;
  try {
    const runtimeCache = await caches.open(cacheNames.runtime);
    runtimeEvicted = await evictNonCacheable(runtimeCache, cacheNames.runtime, protectedPaths);
  } catch (err) {
    logger.warn('[NLPWA] Route-based eviction failed for runtime cache:', err?.message || err);
  }

  return { offlineEvicted, runtimeEvicted };
}
