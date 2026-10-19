/**
 * Cache status values added to responses via the X-Cache-Status header.
 *
 * Clients can read this header from any intercepted response to determine
 * where the response actually came from:
 *
 *   fetch('/app.js').then(r => console.log(r.headers.get('X-Cache-Status')));
 *   // → 'offline-cache' | 'runtime-cache' | 'network' | 'stale' | 'offline-fallback'
 */
export const CACHE_STATUS = {
  /** Response was fetched fresh from the network */
  NETWORK:          'network',

  /** Response came from parallel navigation preload */
  PRELOAD:          'preload',

  /** Response came from the offline (precache / app shell) store */
  OFFLINE_CACHE:    'offline-cache',

  /** Response came from the runtime (lazy) cache */
  RUNTIME_CACHE:    'runtime-cache',

  /** Stale-while-revalidate: served from cache while network update runs in background */
  STALE:            'stale',

  /** Synthetic 503: no network and no cached version available */
  OFFLINE_FALLBACK: 'offline-fallback',

  /** Request bypassed the Service Worker cache */
  BYPASS:           'bypass',
};

/** Name of the response header injected by the SW */
export const CACHE_STATUS_HEADER = 'X-Cache-Status';

/**
 * Wrap a Response with an X-Cache-Status header indicating its origin.
 *
 * Notes:
 *   - Response headers are immutable, so a new Response is constructed.
 *   - Opaque responses (cross-origin, no CORS) cannot have their body read,
 *     so they are returned as-is with no header added.
 *   - The original response is consumed — do not use it after calling this.
 *
 * @param {Response} response
 * @param {string}   status    one of CACHE_STATUS values
 * @returns {Response}
 */
export function tagResponse(response, status) {
  if (!response) return response;

  // Opaque responses (opaque / opaqueredirect / status 0) cannot have their body
  // read or reconstructed without throwing RangeError. Return them unchanged.
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, status);

  const tagged = new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });

  if (response.url) {
    try {
      Object.defineProperty(tagged, 'url', { value: response.url });
    } catch {
      // ignore in environments that do not permit defining url
    }
  }

  if (response.redirected) {
    try {
      Object.defineProperty(tagged, 'redirected', { value: response.redirected });
    } catch {
      // ignore
    }
  }

  return tagged;
}
