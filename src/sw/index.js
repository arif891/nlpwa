import { initConfig, loadConfigFromCache } from './config/index.js';
import { logger } from './logger.js';
import { precacheFiles } from './cache/install.js';
import { getStorageQuotaInfo, cleanRuntimeCache } from './cache/cleanup.js';
import { handleFetch } from './fetch/index.js';
import { checkForUpdate, getUpdateStatus } from './update/index.js';
import { commitIfReady, sweepOrphanCaches } from './update/commit.js';
import {
  getActive, getActiveName, getStaged,
  initClientPins, pinClient, getClientPinnedCache, pruneClientPins,
} from './cache/store.js';
import { MESSAGE_TYPES } from '../shared/constants.js';

/**
 * Initialize the NLPWA Service Worker.
 *
 * @param {Object} userConfig
 */
export function initSW(userConfig = {}) {
  const config = initConfig(userConfig);

  // ── install ────────────────────────────────────────────────────────────────
  self.addEventListener('install', (event) => {
    logger.log(`[NLPWA] Installing SW v${config.version}`);
    event.waitUntil(
      (async () => {
        try {
          const result = await precacheFiles();
          // Only skip waiting if staging/installation completed successfully
          if (!result || result.status !== 'incomplete') {
            await self.skipWaiting();
          }
        } catch (err) {
          logger.error('[NLPWA] Install error:', err);
          throw err;
        }
      })()
    );
  });

  // ── activate ───────────────────────────────────────────────────────────────
  self.addEventListener('activate', (event) => {
    logger.log(`[NLPWA] Activated SW v${config.version}`);
    // Only await fast, local operations in waitUntil so fetch events are never blocked
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
            const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            for (const client of allClients) {
              if (!getClientPinnedCache(client.id)) {
                pinClient(client.id, activeCache);
              }
            }
            await pruneClientPins();
          } catch {}
        }
        await sweepOrphanCaches().catch(() => {});
        await loadConfigFromCache().catch(() => {});
      })()
    );
  });

  // ── fetch ──────────────────────────────────────────────────────────────────
  self.addEventListener('fetch', handleFetch);

  // ── message ────────────────────────────────────────────────────────────────
  // Clients can trigger a manual update check via:
  //   navigator.serviceWorker.controller.postMessage({ type: 'CHECK_UPDATE' })
  self.addEventListener('message', (event) => {
    const port = event.ports?.[0];
    const reply = (replyType, data, error) => {
      const payload = {
        type: replyType,
        requestId: event.data?.requestId,
        data: data ?? null,
        error: error ? (error.message || String(error)) : undefined,
      };
      if (port) {
        port.postMessage(payload);
      } else {
        event.source?.postMessage(payload);
      }
    };

    switch (event.data?.type) {
      case MESSAGE_TYPES.CHECK_UPDATE:
        event.waitUntil((async () => {
          try {
            const result = await checkForUpdate({ force: true });
            reply(MESSAGE_TYPES.CHECK_UPDATE, { result });
          } catch (err) {
            reply(MESSAGE_TYPES.CHECK_UPDATE, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.APPLY_UPDATE:
        // Client asked to switch to the staged update now, then it will reload.
        event.waitUntil((async () => {
          const applied = await commitIfReady(event).catch(() => false);
          reply(MESSAGE_TYPES.APPLY_UPDATE_RESULT, { applied });
        })());
        break;

      case MESSAGE_TYPES.GET_CACHE_INFO:
        // Client requests storage quota & cache metrics info
        event.waitUntil((async () => {
          try {
            const info = await getStorageQuotaInfo();
            reply(MESSAGE_TYPES.CACHE_INFO, info);
          } catch (err) {
            reply(MESSAGE_TYPES.CACHE_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.CLEANUP_RUNTIME:
        // Client requests runtime cache cleanup
        event.waitUntil((async () => {
          try {
            const result = await cleanRuntimeCache(event.data?.options || {});
            reply(MESSAGE_TYPES.RUNTIME_CLEANED, result);
          } catch (err) {
            reply(MESSAGE_TYPES.RUNTIME_CLEANED, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.PIN_CLIENT:
        event.waitUntil((async () => {
          const clientId = event.source?.id;
          if (clientId) {
            const cacheName = event.data?.cache || (await getActiveName(config.caches.offline));
            pinClient(clientId, cacheName);
            reply(MESSAGE_TYPES.CLIENT_PINNED, { clientId, cache: cacheName });
          }
        })());
        break;

      case MESSAGE_TYPES.GET_VERSION:
        event.waitUntil((async () => {
          try {
            const active = await getActive();
            const staged = await getStaged();
            const clientId = event.source?.id;
            const pinnedCache = clientId ? getClientPinnedCache(clientId) : null;
            let pinnedVersion = null;
            if (pinnedCache) {
              const match = pinnedCache.match(/@([^-]+)/);
              pinnedVersion = match ? match[1] : (active?.version || null);
            }
            reply(MESSAGE_TYPES.VERSION_INFO, {
              activeVersion: active?.version || null,
              stagedVersion: staged?.complete ? staged.version : null,
              swVersion: config.version,
              pinnedCache: pinnedCache || active?.cache || null,
              pinnedVersion: pinnedVersion || active?.version || null,
            });
          } catch (err) {
            reply(MESSAGE_TYPES.VERSION_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.GET_STATUS:
        event.waitUntil((async () => {
          try {
            const status = await getUpdateStatus();
            reply(MESSAGE_TYPES.STATUS_INFO, { status });
          } catch (err) {
            reply(MESSAGE_TYPES.STATUS_INFO, null, err);
          }
        })());
        break;
    }
  });

  // ── periodic background sync ───────────────────────────────────────────────
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'nlpwa-update-check') {
      event.waitUntil(checkForUpdate());
    }
  });

  // ── push notifications ─────────────────────────────────────────────────────
  self.addEventListener('push', (event) => {
    if (typeof userConfig.onPush === 'function') {
      try {
        const customRes = userConfig.onPush(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          return;
        }
      } catch (err) {
        logger.warn('[NLPWA] onPush handler error:', err?.message || err);
      }
    }

    if (!event.data) return;

    event.waitUntil((async () => {
      try {
        let payload;
        try {
          payload = event.data.json();
        } catch {
          payload = { body: event.data.text() };
        }

        // Silent background update trigger via Push
        if (payload?.type === 'CHECK_UPDATE' || payload?.nlpwa === 'check-update') {
          await checkForUpdate({ force: true });
          return;
        }

        if (payload?.title && self.registration && typeof self.registration.showNotification === 'function') {
          const { title, ...options } = payload;
          await self.registration.showNotification(title, options);
        }
      } catch (err) {
        logger.warn('[NLPWA] Push handling error:', err?.message || err);
      }
    })());
  });

  self.addEventListener('notificationclick', (event) => {
    if (typeof userConfig.onNotificationClick === 'function') {
      try {
        const customRes = userConfig.onNotificationClick(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          return;
        }
      } catch (err) {
        logger.warn('[NLPWA] onNotificationClick handler error:', err?.message || err);
      }
    }

    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil((async () => {
      if (self.clients && typeof self.clients.matchAll === 'function') {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }
    })());
  });
}
