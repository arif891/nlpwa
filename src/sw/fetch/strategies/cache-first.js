import { getFromCache } from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { resolveMaxAgeMs } from '../../../shared/time.js';
import { isNavigationFallbackAllowed } from '../navigation.js';
import { getPlugins } from '../plugins.js';
import {
  serveCached,
  performFetch,
  safePutInRuntime,
  getShouldThrow,
  resolveFallbackUrl,
  lookupTaggedCache,
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
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);
  const maxAgeMs = resolveMaxAgeMs(options);

  const cached = await lookupTaggedCache({
    request,
    matchOptions,
    clientId,
    plugins,
    options,
    event,
    maxAgeMs,
  });

  if (cached && !(cached instanceof Response) && cached.expired) {
    // Cached copy in runtime has expired: attempt to refresh from network
    try {
      const response = await performFetch(request, event, options, plugins);
      if (options.fallbackOn5xx && response.status >= 500 && response.status < 600) {
        return serveCached(request, cached.response, CACHE_STATUS.RUNTIME_CACHE);
      }
      safePutInRuntime(request, response, event, options);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch {
      // Network failed while refreshing expired asset: serve stale cached copy
      return serveCached(request, cached.response, CACHE_STATUS.RUNTIME_CACHE);
    }
  }

  if (cached instanceof Response) {
    return cached;
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
