import { initConfig, loadConfigFromCache } from './config/index.js';
import { precacheFiles } from './cache/install.js';
import { getStorageQuotaInfo, cleanRuntimeCache } from './cache/cleanup.js';
import { handleFetch } from './fetch/index.js';
import { checkForUpdate, startUpdatePolling } from './update/index.js';
import { commitIfReady, sweepOrphanCaches } from './update/commit.js';
import { MESSAGE_TYPES } from '../shared/constants.js';

/**
 * Initialize the NLPWA Service Worker.
 *
 * @param {Object} userConfig
 */
export function initSW(userConfig = {}) {
  const config = initConfig(userConfig);

  // Eagerly try to hydrate routes and config from offline cache on SW startup
  loadConfigFromCache().catch(() => {});

  // ── install ────────────────────────────────────────────────────────────────
  self.addEventListener('install', (event) => {
    console.log(`[NLPWA] Installing SW v${config.version}`);
    event.waitUntil(
      precacheFiles()
        .then(() => self.skipWaiting())
        .catch(err => console.error('[NLPWA] Install error:', err))
    );
  });

  // ── activate ───────────────────────────────────────────────────────────────
  self.addEventListener('activate', (event) => {
    console.log(`[NLPWA] Activated SW v${config.version}`);
    event.waitUntil(
      self.clients.claim().then(async () => {
        await sweepOrphanCaches().catch(() => {});
        await loadConfigFromCache();
        startUpdatePolling();
        return checkForUpdate();
      })
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
        ...(data || {}),
        data,
        error: error ? (error.message || String(error)) : undefined,
      };
      if (port) {
        port.postMessage(payload);
      } else {
        event.source?.postMessage(payload);
      }
    };

    if (event.data?.type === MESSAGE_TYPES.CHECK_UPDATE) {
      event.waitUntil(checkForUpdate());
    }

    // Client asked to switch to the staged update now, then it will reload.
    if (event.data?.type === MESSAGE_TYPES.APPLY_UPDATE) {
      event.waitUntil((async () => {
        const applied = await commitIfReady().catch(() => false);
        reply(MESSAGE_TYPES.UPDATE_APPLIED, { applied });
      })());
    }

    // Client requests storage quota & cache metrics info
    if (event.data?.type === MESSAGE_TYPES.GET_CACHE_INFO) {
      event.waitUntil((async () => {
        try {
          const info = await getStorageQuotaInfo();
          reply(MESSAGE_TYPES.CACHE_INFO, info);
        } catch (err) {
          reply(MESSAGE_TYPES.CACHE_INFO, null, err);
        }
      })());
    }

    // Client requests runtime cache cleanup
    if (event.data?.type === MESSAGE_TYPES.CLEANUP_RUNTIME) {
      event.waitUntil((async () => {
        try {
          const result = await cleanRuntimeCache(event.data?.options || {});
          reply(MESSAGE_TYPES.RUNTIME_CLEANED, result);
        } catch (err) {
          reply(MESSAGE_TYPES.RUNTIME_CLEANED, null, err);
        }
      })());
    }
  });

  // ── periodic background sync ───────────────────────────────────────────────
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'nlpwa-update-check') {
      event.waitUntil(checkForUpdate());
    }
  });
}
