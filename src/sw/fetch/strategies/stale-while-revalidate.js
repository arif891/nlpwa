import { getFromCache } from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
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
 * Serve from cache immediately (stale), then update the cache in the background.
 * If there is no cached response, fall through to a network fetch (blocks).
 *
 * Best for: feeds, listings, content where slightly stale is acceptable.
 *
 * Response header: X-Cache-Status: stale | network
 *
 * @param {Request} request
 * @param {FetchEvent} [event]  needed to extend SW lifetime for background revalidation
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function staleWhileRevalidate(request, event, options = {}) {
  const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
  const plugins = getPlugins(options);
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);
  const maxAgeMs = resolveMaxAgeMs(options);

  const lookupResult = await lookupTaggedCache({
    request,
    matchOptions,
    clientId,
    plugins,
    options,
    event,
    maxAgeMs,
  });

  const isExpired = Boolean(lookupResult && lookupResult.expired);
  const cached = isExpired ? lookupResult.response : lookupResult;

  if (cached) {
    if (!isExpired) {
      // Serve stale immediately; keep the SW alive for the background refresh.
      const revalidate = (async () => {
        try {
          const response = await performFetch(request, event, options, plugins);
          await safePutInRuntime(request, response, event, options);
          if (typeof options.onRevalidated === 'function') {
            try {
              options.onRevalidated({ request, response, cachedResponse: cached, event });
            } catch (err) {
              logger.debug('[NLPWA] onRevalidated callback threw:', err?.message || err);
            }
          }
          return response;
        } catch (err) {
          logger.debug('[NLPWA] Background revalidation failed (offline/network error):', err?.message || err);
        }
      })();
      if (event && typeof event.waitUntil === 'function') event.waitUntil(revalidate);
      return serveCached(request, cached, CACHE_STATUS.STALE);
    }

    // Cached copy has expired: wait for revalidation (network-first semantics),
    // falling back to the expired cached entry if network fails (offline).
    try {
      const response = await performFetch(request, event, options, plugins);
      if (options.fallbackOn5xx && response.status >= 500 && response.status < 600) {
        return serveCached(request, cached, CACHE_STATUS.STALE);
      }
      await safePutInRuntime(request, response, event, options);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch {
      return serveCached(request, cached, CACHE_STATUS.STALE);
    }
  }

  // No cache — wait for network, fall back to offline handling if network fails
  try {
    const response = await performFetch(request, event, options, plugins);
    await safePutInRuntime(request, response, event, options);
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
