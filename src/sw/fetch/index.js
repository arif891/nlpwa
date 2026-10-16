import { ensureConfigReady } from '../config/index.js';
import { resolveStrategy } from './router.js';

/**
 * Handle all `fetch` events from the Service Worker.
 *
 * Filters:
 *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
 *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
 *
 * Ensures runtime config is hydrated from offline cache before matching routes.
 *
 * @param {FetchEvent} event
 */
export function handleFetch(event) {
  const { request } = event;

  // Only intercept GET requests
  if (request.method !== 'GET') return;

  // Only intercept http(s) requests
  if (!request.url.startsWith('http')) return;

  event.respondWith(
    (async () => {
      await ensureConfigReady();
      const strategyFn = resolveStrategy(request);
      return strategyFn(request, event);
    })()
  );
}
