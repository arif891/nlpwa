import { logger } from '../logger.js';
import { loadConfigFromCache } from '../config/index.js';
import { sweepOrphanCaches } from '../update/commit.js';
import {
  getActive,
  getActiveName,
  initClientPins,
  pinClient,
  getClientPinnedCache,
  pruneClientPins,
} from '../cache/store.js';

/**
 * Service Worker activate event handler.
 *
 * @param {Object} config
 * @returns {(event: ExtendableEvent) => void}
 */
export function handleActivate(config) {
  return (event) => {
    logger.log(`[NLPWA] Activated SW v${config.version}`);
    event.waitUntil(
      (async () => {
        await self.clients.claim();
        if (self.registration && 'navigationPreload' in self.registration) {
          try {
            if (config.navigationPreload) {
              await self.registration.navigationPreload.enable();
              if (typeof config.navigationPreload === 'string') {
                await self.registration.navigationPreload.setHeaderValue(config.navigationPreload);
              }
            } else {
              await self.registration.navigationPreload.disable();
            }
          } catch {
            // navigationPreload not supported or disabled in browser
          }
        }
        await initClientPins();
        if (self.clients && typeof self.clients.matchAll === 'function') {
          try {
            const activeCache = await getActiveName(config.caches.offline);
            const activeSnapshot = await getActive();
            const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            for (const client of allClients) {
              if (!getClientPinnedCache(client.id)) {
                await pinClient(client.id, activeCache, activeSnapshot?.version || null);
              }
            }
            await pruneClientPins();
          } catch {}
        }
        await sweepOrphanCaches().catch(() => {});
        await loadConfigFromCache().catch(() => {});
      })()
    );
  };
}
