import { initConfig, loadConfigFromCache } from './config/index.js';
import { precacheFiles } from './cache/install.js';
import { handleFetch } from './fetch/index.js';
import { checkForUpdate, startUpdatePolling } from './update/index.js';
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
    if (event.data?.type === MESSAGE_TYPES.CHECK_UPDATE) {
      event.waitUntil(checkForUpdate());
    }
  });

  // ── periodic background sync ───────────────────────────────────────────────
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'nlpwa-update-check') {
      event.waitUntil(checkForUpdate());
    }
  });
}
