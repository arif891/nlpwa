import { ensureConfigReady, getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { resolveStrategy } from './router.js';
import { commitIfReady } from '../update/commit.js';
import { initClientPins, pinClient, touchClientPin, getClientPinnedCache, getActiveName, getActive } from '../cache/store.js';
import { isShareTargetRequest, handleShareTarget } from '../features/share-target.js';

/**
 * Handle all `fetch` events from the Service Worker.
 *
 * Filters:
 *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
 *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
 *
 * Ensures runtime config is hydrated from offline cache before matching routes,
 * switches to a staged update on navigation requests, and maintains per-client
 * version pins so open tabs are isolated from subsequent updates in other tabs.
 *
 * @param {FetchEvent} event
 */
export function handleFetch(event) {
  const { request } = event;

  // Intercept Web Share Target requests (GET or POST) before generic method filtering
  const currentConfig = getConfig();
  if (isShareTargetRequest(request, currentConfig)) {
    event._nlpwaIntercepted = true;
    event.respondWith(
      (async () => {
        await ensureConfigReady();
        return handleShareTarget(event, getConfig());
      })()
    );
    return;
  }

  // Intercept GET requests, or non-GET mutations when plugins or direct hooks are configured
  if (request.method !== 'GET') {
    const config = currentConfig;
    const hasGlobalPlugins = Array.isArray(config?.plugins) && config.plugins.length > 0;
    const hasRoutePlugins = Array.isArray(config?.routes) && config.routes.some((r) => {
      if (Array.isArray(r?.plugins) && r.plugins.length > 0) return true;
      return (
        typeof r?.fetchDidFail === 'function' ||
        typeof r?.requestWillFetch === 'function' ||
        typeof r?.fetchDidSucceed === 'function' ||
        typeof r?.cacheDidUpdate === 'function' ||
        typeof r?.cacheWillUpdate === 'function' ||
        typeof r?.cacheKeyWillBeUsed === 'function' ||
        typeof r?.cachedResponseWillBeUsed === 'function'
      );
    });
    if (!hasGlobalPlugins && !hasRoutePlugins) {
      return;
    }
  }

  // Only intercept http(s) requests
  if (!request.url.startsWith('http')) return;

  event._nlpwaIntercepted = true;

  event.respondWith(
    (async () => {
      await ensureConfigReady();
      await initClientPins();

      // A staged update goes live only when a new page load starts, so one
      // page is never served half from the old version and half from the new.
      let pinPromise = null;
      if (request.mode === 'navigate') {
        await commitIfReady(event).catch((err) => logger.warn('[NLPWA] Commit failed:', err.message));
        const activeCacheName = await getActiveName(getConfig().caches.offline);
        const activeSnapshot = await getActive();
        if (event.resultingClientId) {
          pinPromise = pinClient(event.resultingClientId, activeCacheName, activeSnapshot?.version || null);
        }
      } else if (event.clientId && !getClientPinnedCache(event.clientId)) {
        // Pin existing client to current active version on its first subresource fetch
        // so mid-session commits in other tabs never break its asset versioning
        const activeCacheName = await getActiveName(getConfig().caches.offline);
        const activeSnapshot = await getActive();
        pinPromise = pinClient(event.clientId, activeCacheName, activeSnapshot?.version || null);
      } else if (event.clientId) {
        touchClientPin(event.clientId);
      }

      if (pinPromise) {
        if (event && typeof event.waitUntil === 'function') {
          event.waitUntil(pinPromise);
        }
        await pinPromise;
      }

      const strategyFn = resolveStrategy(request);
      return strategyFn(request, event);
    })()
  );
}
