import {
  getFromCache,
  getFromOffline,
  getFromRuntime,
  putInRuntime,
} from '../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../cache/tag.js';
import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { createRangeResponse } from './range.js';
import { isNavigationFallbackAllowed } from './navigation.js';
import {
  getPlugins,
  runRequestWillFetch,
  runCachedResponseWillBeUsed,
  runCacheWillUpdate,
  runFetchDidSucceed,
  runFetchDidFail,
  runCacheDidUpdate,
  runCacheKeyWillBeUsed,
} from './plugins.js';

export {
  createRangeResponse,
  isNavigationFallbackAllowed,
  getPlugins,
  runRequestWillFetch,
  runCachedResponseWillBeUsed,
  runCacheWillUpdate,
  runFetchDidSucceed,
  runFetchDidFail,
  runCacheDidUpdate,
  runCacheKeyWillBeUsed,
};

/**
 * Helper to tag a cached response and handle Range requests if requested.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {string} tag
 * @returns {Promise<Response>}
 */
async function serveCached(request, response, tag) {
  const tagged = tagResponse(response, tag);
  if (request?.headers && typeof request.headers.has === 'function' && request.headers.has('range')) {
    return createRangeResponse(request, tagged);
  }
  return tagged;
}

/**
 * Execute a network fetch through requestWillFetch, fetchDidSucceed, and fetchDidFail plugin hooks.
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @param {Array<Object>} [plugins]
 * @returns {Promise<Response>}
 */
async function performFetch(request, event, options = {}, plugins = getPlugins(options)) {
  const finalRequest = await runRequestWillFetch(plugins, { request, event, options });
  try {
    const rawResponse = await fetch(finalRequest);
    const finalResponse = await runFetchDidSucceed(plugins, {
      request: finalRequest,
      response: rawResponse,
      event,
      options,
    });
    return finalResponse;
  } catch (err) {
    await runFetchDidFail(plugins, {
      error: err,
      originalRequest: request,
      request: finalRequest,
      event,
      options,
    });
    throw err;
  }
}

/**
 * Safely put a response clone into the runtime cache without blocking the main response.
 * - Runs cacheWillUpdate plugin hooks; cancels write if hook returns null/false.
 * - Skips 206 Partial Content (Range requests) to prevent Cache Storage API TypeError.
 * - Skips non-2xx responses.
 * - Catches QuotaExceededError or write failures without breaking the caller.
 * - Runs cacheDidUpdate plugin hook after successful write.
 * - Extends SW lifetime via event.waitUntil() if event is available.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 */
function safePutInRuntime(request, response, event, options = {}) {
  if (!response || response.status === 206) return Promise.resolve();
  if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) return Promise.resolve();

  // Opaque responses:
  // In Chromium, caching an opaque response (type === 'opaque', status === 0) incurs ~7 MB
  // quota padding to prevent side-channel size attacks, and 404/500 errors cannot be detected.
  // We skip caching opaque responses by default unless explicitly opted in via cacheOpaque: true.
  if (response.type === 'opaque') {
    const allowOpaque = Boolean(
      options?.cacheOpaque ??
      getConfig().cacheOpaque ??
      false
    );
    if (!allowOpaque) {
      return Promise.resolve();
    }
  } else if (!response.ok) {
    return Promise.resolve();
  }

  let toCache;
  try {
    toCache = response.clone();
  } catch (err) {
    logger.warn('[NLPWA] Could not clone response for runtime cache:', err?.message || err);
    return Promise.resolve();
  }

  const asyncWrite = (async () => {
    const plugins = getPlugins(options);
    const cacheName = getConfig().caches?.runtime || 'runtime';

    let cacheKey = request;
    try {
      cacheKey = await runCacheKeyWillBeUsed(plugins, {
        request,
        mode: 'write',
        event,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
    }

    let responseToCache;
    try {
      responseToCache = await runCacheWillUpdate(plugins, {
        request: cacheKey,
        response: toCache,
        event,
        cacheName,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] cacheWillUpdate error:', err?.message || err);
      return;
    }

    if (!responseToCache) return;

    if (responseToCache.type === 'opaque') {
      const allowOpaque = Boolean(
        options?.cacheOpaque ??
        getConfig().cacheOpaque ??
        false
      );
      if (!allowOpaque) return;
    } else if (!responseToCache.ok) {
      return;
    }

    try {
      await putInRuntime(cacheKey, responseToCache);
      await runCacheDidUpdate(plugins, {
        cacheName,
        request: cacheKey,
        newResponse: responseToCache,
        event,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] Runtime cache write failed:', err?.message || err);
    }
  })();

  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(asyncWrite);
  }
  return asyncWrite;
}

/**
 * Determine whether a strategy failure should rethrow/reject instead of returning a 503 response.
 */
function getShouldThrow(options) {
  return Boolean(
    options?.throwOnFailure ??
    getConfig().throwOnFailure ??
    false
  );
}

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: '7d', '24h', '30m', '60s', '500ms', or plain numbers (ms).
 *
 * @param {string|number} [val]
 * @returns {number|null}
 */
export function parseDurationMs(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    return val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    const unit = match[2] || 'ms';
    if (unit === 'w') return Math.round(num * 7 * 24 * 60 * 60 * 1000);
    if (unit === 'd') return Math.round(num * 24 * 60 * 60 * 1000);
    if (unit === 'h') return Math.round(num * 60 * 60 * 1000);
    if (unit === 'm') return Math.round(num * 60 * 1000);
    if (unit === 's') return Math.round(num * 1000);
    return Math.round(num);
  }
  return null;
}

/**
 * Resolve max age in milliseconds from route options or global config.
 */
function resolveMaxAgeMs(options) {
  if (options?.maxAge != null) return parseDurationMs(options.maxAge);
  return null;
}

/**
 * Resolve offline navigation fallback URL from route options or global config.
 */
function resolveFallbackUrl(options = {}) {
  return options.offlineFallback ?? options.navigationFallback ?? getConfig().offlineFallback ?? getConfig().navigationFallback ?? '/index.html';
}

/**
 * Check if a cached Response has expired based on its cached timestamp and maxAgeMs.
 */
function isResponseExpired(response, maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0 || !response) return false;
  const cachedAtHeader = response.headers?.get('X-NLPWA-Cached-At');
  let cachedAt = 0;
  if (cachedAtHeader) {
    const parsed = parseInt(cachedAtHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
  } else {
    const dateHeader = response.headers?.get('Date');
    if (dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
    }
  }
  if (!cachedAt) return false;
  return (Date.now() - cachedAt) > maxAgeMs;
}

// ── cache-first ──────────────────────────────────────────────────────────

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

// ── network-first ──────────────────────────────────────────────────────────

/**
 * Try network first. On failure or timeout, fall back to cache (offline → runtime).
 * Successful network responses are stored in runtime cache asynchronously.
 * If offline and no cache matches a navigation request, falls back to navigationFallback (e.g. /index.html).
 *
 * Best for: HTML pages, user data — content that should be fresh when online.
 *
 * Response header: X-Cache-Status: network | preload | offline-cache | runtime-cache | offline-fallback
 */

/** Look in offline then runtime cache; returns a tagged Response or null. */
async function lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event }) {
  let cacheKey = request;
  try {
    cacheKey = await runCacheKeyWillBeUsed(plugins, { request, mode: 'read', event, options });
  } catch (err) {
    logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
  }

  const offlineName = getConfig().caches?.offline || 'offline';
  const runtimeName = getConfig().caches?.runtime || 'runtime';

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
    if (runtimeCached) return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
  }

  return null;
}

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
        // With nothing cached, a slow response is better than a synthetic 503,
        // so keep waiting for the original request.
        const cached = await lookupCache();
        if (cached) {
          // Let the slow request finish in the background so the cache is
          // refreshed for next time.
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

// ── network-only ──────────────────────────────────────────────────────────

/**
 * Always fetch from network. Never read from or write to any cache.
 *
 * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
 *
 * Response header: X-Cache-Status: network
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function networkOnly(request, event, options = {}) {
  const plugins = getPlugins(options);
  try {
    const response = await performFetch(request, event, options, plugins);
    return tagResponse(response, CACHE_STATUS.NETWORK);
  } catch (err) {
    if (getShouldThrow(options)) {
      throw err;
    }
    return tagResponse(
      new Response('Offline — network request failed.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      CACHE_STATUS.OFFLINE_FALLBACK,
    );
  }
}

// ── stale-while-revalidate ───────────────────────────────────────────────────

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
  const runtimeName = getConfig().caches?.runtime || 'runtime';
  const offlineName = getConfig().caches?.offline || 'offline';
  const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

  let cacheKey = request;
  try {
    cacheKey = await runCacheKeyWillBeUsed(plugins, { request, mode: 'read', event, options });
  } catch (err) {
    logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
  }

  let cached = await getFromRuntime(cacheKey, matchOptions);
  let cacheNameUsed = runtimeName;
  if (!cached) {
    cached = await getFromOffline(cacheKey, matchOptions, clientId);
    cacheNameUsed = offlineName;
  }

  if (cached) {
    cached = await runCachedResponseWillBeUsed(plugins, {
      cacheName: cacheNameUsed,
      request: cacheKey,
      matchOptions,
      cachedResponse: cached,
      event,
      options,
    });
  }

  const maxAgeMs = resolveMaxAgeMs(options);

  if (cached) {
    const expired = maxAgeMs ? isResponseExpired(cached, maxAgeMs) : false;
    if (!expired) {
      // Serve stale immediately; keep the SW alive for the background refresh.
      const revalidate = (async () => {
        try {
          const response = await performFetch(request, event, options, plugins);
          await safePutInRuntime(request, response, event, options);
          if (typeof options.onRevalidated === 'function') {
            try {
              options.onRevalidated({ request, response, cachedResponse: cached, event });
            } catch {}
          }
          return response;
        } catch {
          // offline during revalidation is fine
        }
      })();
      if (event && typeof event.waitUntil === 'function') event.waitUntil(revalidate);
      return serveCached(request, cached, CACHE_STATUS.STALE);
    }

    // Cached copy has expired: wait for revalidation (network-first semantics),
    // falling back to the expired cached entry if network fails (offline).
    try {
      const response = await performFetch(request, event, options, plugins);
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

// ── cache-only ──────────────────────────────────────────────────────────

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
