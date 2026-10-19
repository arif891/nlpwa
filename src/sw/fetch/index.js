import { ensureConfigReady } from '../config/index.js';
import { resolveStrategy } from './router.js';
import { commitIfReady } from '../update/commit.js';

/**
 * Handle all `fetch` events from the Service Worker.
 *
 * Filters:
 *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
 *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
 *
 * Ensures runtime config is hydrated from offline cache before matching routes,
 * and switches to a staged update on navigation requests.
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
      // A staged update goes live only when a new page load starts, so one
      // page is never served half from the old version and half from the new.
      if (request.mode === 'navigate') {
        await commitIfReady(event).catch((err) => console.warn('[NLPWA] Commit failed:', err.message));
      }
      const strategyFn = resolveStrategy(request);
      return strategyFn(request, event);
    })()
  );
}
