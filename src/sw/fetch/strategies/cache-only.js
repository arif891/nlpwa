import { getFromCache } from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { isNavigationFallbackAllowed } from '../navigation.js';
import { getPlugins } from '../plugins.js';
import {
  getShouldThrow,
  resolveFallbackUrl,
  lookupTaggedCache,
} from './context.js';

/**
 * Serve exclusively from cache. Never hit the network.
 * Returns a 503 if the resource is not cached (or throws if throwOnFailure is true).
 *
 * Best for: offline-only fallback resources (placeholder pages, offline.html).
 *
 * Response header: X-Cache-Status: offline-cache | runtime-cache | offline-fallback
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function cacheOnly(request, event, options = {}) {
  const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
  const plugins = getPlugins(options);
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

  const cached = await lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event });
  if (cached) return cached;

  if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
    const fallbackUrl = resolveFallbackUrl(options);
    const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
    if (fallbackRes) {
      return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
    }
  }

  if (getShouldThrow(options)) {
    throw new Error('Failed to fetch: not available in offline cache.');
  }

  return tagResponse(
    new Response('Not available offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    }),
    CACHE_STATUS.OFFLINE_FALLBACK,
  );
}
