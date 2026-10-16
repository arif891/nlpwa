import {
  getFromCache,
  getFromOffline,
  getFromRuntime,
  putInRuntime,
} from '../cache/index.js';

// ── cache-first ──────────────────────────────────────────────────────────────

/**
 * Serve from offline cache first, then runtime cache.
 * On cache miss, fetch from network and store in runtime cache.
 *
 * Best for: static assets, fonts, images — files that rarely change.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function cacheFirst(request) {
  const cached = await getFromCache(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response);
  return response;
}

// ── network-first ────────────────────────────────────────────────────────────

/**
 * Try network first. On failure, fall back to cache (offline → runtime).
 * Successful network responses are stored in the runtime cache.
 *
 * Best for: HTML pages, user data — content that should be fresh when online.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await putInRuntime(request, response);
    return response;
  } catch {
    const cached = await getFromCache(request);
    if (cached) return cached;
    // Return a typed offline error response instead of throwing
    return new Response('Offline — no cached version available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ── network-only ─────────────────────────────────────────────────────────────

/**
 * Always fetch from network. Never read from or write to any cache.
 *
 * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function networkOnly(request) {
  return fetch(request);
}

// ── stale-while-revalidate ───────────────────────────────────────────────────

/**
 * Serve from cache immediately (stale), then update the cache in the background.
 * If there is no cached response, fall through to a network fetch (blocks).
 *
 * Best for: feeds, listings, content where slightly stale is acceptable.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function staleWhileRevalidate(request) {
  const cached = await getFromRuntime(request) ?? await getFromOffline(request);

  // Kick off background revalidation (fire-and-forget)
  const revalidate = fetch(request)
    .then(async (response) => {
      if (response.ok) await putInRuntime(request, response);
    })
    .catch(() => {/* Network error during revalidation is silently ignored */});

  // If we have a cached response, serve it immediately and revalidate in bg
  if (cached) {
    // Attach revalidation as a background task so SW doesn't die early
    // (caller should use event.waitUntil on the returned promise if needed)
    void revalidate;
    return cached;
  }

  // No cache — wait for network
  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response);
  return response;
}

// ── cache-only ───────────────────────────────────────────────────────────────

/**
 * Serve exclusively from cache. Never hit the network.
 * Returns a 503 if the resource is not cached.
 *
 * Best for: offline-only fallback resources (placeholder pages, offline.html).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function cacheOnly(request) {
  const cached = await getFromCache(request);
  if (cached) return cached;
  return new Response('Not available offline.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}
