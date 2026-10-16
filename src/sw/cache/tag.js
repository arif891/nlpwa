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

  /** Response came from the offline (precache / app shell) store */
  OFFLINE_CACHE:    'offline-cache',

  /** Response came from the runtime (lazy) cache */
  RUNTIME_CACHE:    'runtime-cache',

  /** Stale-while-revalidate: served from cache while network update runs in background */
  STALE:            'stale',

  /** Synthetic 503: no network and no cached version available */
  OFFLINE_FALLBACK: 'offline-fallback',
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
  // Opaque responses (type === 'opaque') cannot be reconstructed —
  // their body stream is locked and unreadable. Return them unchanged.
  if (response.type === 'opaque') return response;

  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, status);

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}
