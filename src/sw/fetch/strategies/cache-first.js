import { getFromCache, getFromOffline, getFromRuntime } from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { resolveMaxAgeMs, isResponseExpired } from '../../../shared/time.js';
import { isNavigationFallbackAllowed } from '../navigation.js';
import {
  getPlugins,
  runCachedResponseWillBeUsed,
  runCacheKeyWillBeUsed,
} from '../plugins.js';
import {
  serveCached,
  performFetch,
  safePutInRuntime,
  getShouldThrow,
  resolveFallbackUrl,
} from './context.js';

/**
 * Serve from offline cache first, then runtime cache.
 * On cache miss, fetch from network and store in runtime cache asynchronously.
 *
 * Best for: static assets, fonts, images — files that rarely change.
 *
 * Response header: X-Cache-Status: offline-cache | runtime-cache | network
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function cacheFirst(request, event, options = {}) {
  const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
  const plugins = getPlugins(options);
  const offlineName = getConfig().caches?.offline || 'offline';
  const runtimeName = getConfig().caches?.runtime || 'runtime';
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

  let cacheKey = request;
  try {
    cacheKey = await runCacheKeyWillBeUsed(plugins, { request, mode: 'read', event, options });
  } catch (err) {
    logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
  }

  let offlineCached = await getFromOffline(cacheKey, matchOptions, clientId);
  if (offlineCached) {
    offlineCached = await runCachedResponseWillBeUsed(plugins, {
      cacheName: offlineName,
      request: cacheKey,
      matchOptions,
      cachedResponse: offlineCached,
      event,
      options,
    });
    if (offlineCached) return serveCached(request, offlineCached, CACHE_STATUS.OFFLINE_CACHE);
  }

  const maxAgeMs = resolveMaxAgeMs(options);
  let runtimeCached = await getFromRuntime(cacheKey, matchOptions);
  if (runtimeCached) {
    runtimeCached = await runCachedResponseWillBeUsed(plugins, {
      cacheName: runtimeName,
      request: cacheKey,
      matchOptions,
      cachedResponse: runtimeCached,
      event,
      options,
    });
    if (runtimeCached) {
      const expired = maxAgeMs ? isResponseExpired(runtimeCached, maxAgeMs) : false;
      if (!expired) {
        return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
      }

      // Cached copy has expired: attempt to refresh from network
      try {
        const response = await performFetch(request, event, options, plugins);
        safePutInRuntime(request, response, event, options);
        return tagResponse(response, CACHE_STATUS.NETWORK);
      } catch {
        // Network failed while refreshing expired asset: serve stale cached copy
        return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
      }
    }
  }

  try {
    const response = await performFetch(request, event, options, plugins);
    safePutInRuntime(request, response, event, options);
    return tagResponse(response, CACHE_STATUS.NETWORK);
  } catch (err) {
    // Navigation fallback for SPAs or offline pages
    if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
      const fallbackUrl = resolveFallbackUrl(options);
      const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
      if (fallbackRes) {
        return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
      }
    }

    if (getShouldThrow(options)) {
      throw err;
    }

    // Return a typed offline error response instead of throwing
    return tagResponse(
      new Response('Offline — no cached version available.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      CACHE_STATUS.OFFLINE_FALLBACK,
    );
  }
}
