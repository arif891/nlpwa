import {
  getFromCache,
  getFromOffline,
  getFromRuntime,
  putInRuntime,
  tagResponse,
  CACHE_STATUS,
} from '../cache/index.js';

// ── cache-first ──────────────────────────────────────────────────────────────

/**
 * Serve from offline cache first, then runtime cache.
 * On cache miss, fetch from network and store in runtime cache.
 *
 * Best for: static assets, fonts, images — files that rarely change.
 *
 * Response header: X-Cache-Status: offline-cache | runtime-cache | network
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function cacheFirst(request) {
  const offlineCached = await getFromOffline(request);
  if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

  const runtimeCached = await getFromRuntime(request);
  if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response.clone());
  return tagResponse(response, CACHE_STATUS.NETWORK);
}

// ── network-first ────────────────────────────────────────────────────────────

/**
 * Try network first. On failure, fall back to cache (offline → runtime).
 * Successful network responses are stored in the runtime cache.
 *
 * Best for: HTML pages, user data — content that should be fresh when online.
 *
 * Response header: X-Cache-Status: network | offline-cache | runtime-cache | offline-fallback
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await putInRuntime(request, response.clone());
    return tagResponse(response, CACHE_STATUS.NETWORK);
  } catch {
    const offlineCached = await getFromOffline(request);
    if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

    const runtimeCached = await getFromRuntime(request);
    if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

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

// ── network-only ─────────────────────────────────────────────────────────────

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
 * @param {FetchEvent} event  needed to extend SW lifetime for background revalidation
 * @returns {Promise<Response>}
 */
export async function staleWhileRevalidate(request, event) {
  const cached = await getFromRuntime(request) ?? await getFromOffline(request);

  // Kick off background revalidation (fire-and-forget, but extended into SW lifetime)
  const revalidate = fetch(request)
    .then(async (response) => {
      if (response.ok) await putInRuntime(request, response);
    })
    .catch(() => {/* Network error during revalidation is silently ignored */});

  // If we have a cached response, serve it immediately and revalidate in bg.
  // Pass the revalidation promise to event.waitUntil() so the SW isn't killed
  // before the background cache write completes.
  if (cached) {
    if (event) event.waitUntil(revalidate);
    return tagResponse(cached, CACHE_STATUS.STALE);
  }

  // No cache — wait for network
  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response.clone());
  return tagResponse(response, CACHE_STATUS.NETWORK);
}

// ── cache-only ───────────────────────────────────────────────────────────────

/**
 * Serve exclusively from cache. Never hit the network.
 * Returns a 503 if the resource is not cached.
 *
 * Best for: offline-only fallback resources (placeholder pages, offline.html).
 *
 * Response header: X-Cache-Status: offline-cache | runtime-cache | offline-fallback
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function cacheOnly(request) {
  const offlineCached = await getFromOffline(request);
  if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

  const runtimeCached = await getFromRuntime(request);
  if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

  return tagResponse(
    new Response('Not available offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    }),
    CACHE_STATUS.OFFLINE_FALLBACK,
  );
}
