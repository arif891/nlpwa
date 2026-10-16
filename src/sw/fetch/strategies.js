import {
  getFromCache,
  getFromOffline,
  getFromRuntime,
  putInRuntime,
  tagResponse,
  CACHE_STATUS,
} from '../cache/index.js';
import { getConfig } from '../config/index.js';

/**
 * Safely put a response clone into the runtime cache without blocking the main response.
 * - Skips 206 Partial Content (Range requests) to prevent Cache Storage API TypeError.
 * - Skips non-2xx responses.
 * - Catches QuotaExceededError or write failures without breaking the caller.
 * - Extends SW lifetime via event.waitUntil() if event is available.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {FetchEvent} [event]
 */
function safePutInRuntime(request, response, event) {
  if (!response || !response.ok || response.status === 206) return;
  if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) return;

  try {
    const clone = response.clone();
    const writePromise = putInRuntime(request, clone).catch((err) => {
      console.warn('[NLPWA] Runtime cache write failed:', err.message);
    });

    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(writePromise);
    }
  } catch (err) {
    console.warn('[NLPWA] Could not clone response for runtime cache:', err.message);
  }
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

  const offlineCached = await getFromOffline(request, matchOptions);
  if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

  const runtimeCached = await getFromRuntime(request, matchOptions);
  if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

  const response = await fetch(request);
  safePutInRuntime(request, response, event);
  return tagResponse(response, CACHE_STATUS.NETWORK);
}

// ── network-first ──────────────────────────────────────────────────────────

/**
 * Try network first. On failure or timeout, fall back to cache (offline → runtime).
 * Successful network responses are stored in runtime cache asynchronously.
 * If offline and no cache matches a navigation request, falls back to navigationFallback (e.g. /index.html).
 *
 * Best for: HTML pages, user data — content that should be fresh when online.
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

  /** Look in offline then runtime cache; returns a tagged Response or null. */
  const lookupCache = async () => {
    const offlineCached = await getFromOffline(request, matchOptions);
    if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

    const runtimeCached = await getFromRuntime(request, matchOptions);
    if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

    return null;
  };

  const networkPromise = fetch(request);

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
            .then((res) => { safePutInRuntime(request, res, event); })
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

    safePutInRuntime(request, response, event);
    return tagResponse(response, CACHE_STATUS.NETWORK);
  } catch {
    const cached = await lookupCache();
    if (cached) return cached;

    // Navigation fallback for SPAs or offline pages
    if (request.mode === 'navigate') {
      const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
      const fallbackRes = await getFromCache(fallbackUrl);
      if (fallbackRes) {
        return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
      }
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

// ── network-only ──────────────────────────────────────────────────────────

/**
 * Always fetch from network. Never read from or write to any cache.
 *
 * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
 *
 * Response header: X-Cache-Status: network
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function networkOnly(request) {
  return tagResponse(await fetch(request), CACHE_STATUS.NETWORK);
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
  const cached = (await getFromRuntime(request, matchOptions)) ?? (await getFromOffline(request, matchOptions));

  // Single network request, shared by the background refresh and the
  // cache-miss path (previously a miss issued two identical fetches).
  const revalidate = fetch(request).then((response) => {
    // clone() happens synchronously here, before the caller consumes the body
    safePutInRuntime(request, response, event);
    return response;
  });

  if (cached) {
    // Serve stale immediately; keep the SW alive for the background refresh.
    const settled = revalidate.catch(() => {/* offline during revalidation is fine */});
    if (event && typeof event.waitUntil === 'function') event.waitUntil(settled);
    return tagResponse(cached, CACHE_STATUS.STALE);
  }

  // No cache — wait for the same request
  const response = await revalidate;
  return tagResponse(response, CACHE_STATUS.NETWORK);
}

// ── cache-only ──────────────────────────────────────────────────────────

/**
 * Serve exclusively from cache. Never hit the network.
 * Returns a 503 if the resource is not cached.
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

  const offlineCached = await getFromOffline(request, matchOptions);
  if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

  const runtimeCached = await getFromRuntime(request, matchOptions);
  if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

  if (request.mode === 'navigate') {
    const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
    const fallbackRes = await getFromCache(fallbackUrl);
    if (fallbackRes) {
      return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
    }
  }

  return tagResponse(
    new Response('Not available offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    }),
    CACHE_STATUS.OFFLINE_FALLBACK,
  );
}
