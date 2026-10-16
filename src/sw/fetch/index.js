import { resolveStrategy } from './router.js';

/**
 * Handle all `fetch` events from the Service Worker.
 *
 * Filters:
 *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
 *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
 *
 * The `event` is forwarded to the strategy so that stale-while-revalidate
 * can extend the SW lifetime via event.waitUntil() for its background fetch.
 *
 * @param {FetchEvent} event
 */
export function handleFetch(event) {
  const { request } = event;

  // Only intercept GET requests
  if (request.method !== 'GET') return;

  // Only intercept http(s) requests
  if (!request.url.startsWith('http')) return;

  const strategyFn = resolveStrategy(request);
  event.respondWith(strategyFn(request, event));
}
