import { getFromCache } from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { getConfig } from '../../config/index.js';
import { isNavigationFallbackAllowed } from '../navigation.js';
import { getPlugins, runFetchDidSucceed } from '../plugins.js';
import {
  performFetch,
  safePutInRuntime,
  getShouldThrow,
  resolveFallbackUrl,
  lookupTaggedCache,
} from './context.js';

/**
 * Fetch from network first. On network failure or timeout, fall back to cache.
 * Write successful responses to the runtime cache asynchronously.
 *
 * Best for: API data, HTML pages that must stay fresh.
 *
 * Response header: X-Cache-Status: network | offline-cache | runtime-cache | offline-fallback
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function networkFirst(request, event, options = {}) {
  const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
  const timeoutMs = options.networkTimeoutMs ?? getConfig().networkTimeoutMs ?? 0;
  const plugins = getPlugins(options);
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

  const lookupCache = () => lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event });

  // Navigation preload optimization: parallel fetch started by the browser during SW startup
  let preloadPromise = null;
  if (request.mode === 'navigate' && event?.preloadResponse) {
    preloadPromise = event.preloadResponse;
  }

  let fromPreload = false;
  const networkPromise = (async () => {
    if (preloadPromise) {
      try {
        const preloaded = await preloadPromise;
        if (preloaded) {
          fromPreload = true;
          return runFetchDidSucceed(plugins, {
            request,
            response: preloaded,
            event,
            options,
          });
        }
      } catch {
        // Preload aborted or unavailable; fall through to network fetch
      }
    }
    return performFetch(request, event, options, plugins);
  })();

  try {
    let response;

    if (timeoutMs > 0) {
      const TIMED_OUT = Symbol('timeout');
      let timerId;
      const timeout = new Promise((resolve) => {
        timerId = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });

      let result;
      try {
        result = await Promise.race([networkPromise, timeout]);
      } finally {
        clearTimeout(timerId);
      }

      if (result === TIMED_OUT) {
        // Only give up on the network if we actually have something to serve.
        const cached = await lookupCache();
        if (cached) {
          const refresh = networkPromise
            .then((res) => safePutInRuntime(request, res, event, options))
            .catch(() => {});
          if (event && typeof event.waitUntil === 'function') event.waitUntil(refresh);
          return cached;
        }
        response = await networkPromise;
      } else {
        response = result;
      }
    } else {
      response = await networkPromise;
    }

    safePutInRuntime(request, response, event, options);
    return tagResponse(response, fromPreload ? CACHE_STATUS.PRELOAD : CACHE_STATUS.NETWORK);
  } catch (err) {
    const cached = await lookupCache();
    if (cached) return cached;

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
      new Response('Offline — network request failed.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      CACHE_STATUS.OFFLINE_FALLBACK,
    );
  }
}
