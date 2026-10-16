import { initConfig } from './config/index.js';
import { precacheFiles } from './cache/install.js';
import { handleFetch } from './fetch/index.js';
import { checkForUpdate, startUpdatePolling } from './update/index.js';
import { MESSAGE_TYPES } from '../shared/constants.js';

/**
 * Initialize the NLPWA Service Worker.
 *
 * Call this once at the top of your sw.js:
 *
 *   import { initSW } from './nlpwa/src/sw/index.js';
 *   // or from the built file:
 *   // importScripts('/nlpwa.sw.js');
 *
 *   initSW({
 *     version: '1.0.0',
 *     precache: ['/', '/index.html', '/app.js'],
 *     routes: [
 *       { match: '/api/**',    strategy: 'network-only' },
 *       { match: '/assets/**', strategy: 'cache-first'  },
 *       { match: '**',         strategy: 'network-first'},
 *     ],
 *   });
 *
 * @param {Object} userConfig  see src/sw/config/defaults.js for all options
 */
export function initSW(userConfig = {}) {
  const config = initConfig(userConfig);

  // ── install ────────────────────────────────────────────────────────────────
  // Pre-cache the app shell. skipWaiting() ensures the new SW takes over
  // immediately without waiting for existing tabs to close.
  self.addEventListener('install', (event) => {
    console.log(`[NLPWA] Installing v${config.version}`);
    event.waitUntil(
      precacheFiles()
        .then(() => self.skipWaiting())
        .catch(err => console.error('[NLPWA] Install error:', err))
    );
  });

  // ── activate ───────────────────────────────────────────────────────────────
  // clients.claim() lets the new SW control already-open tabs immediately.
  // Update polling starts here so it doesn't run in an uncontrolled SW.
  self.addEventListener('activate', (event) => {
    console.log(`[NLPWA] Activated v${config.version}`);
    event.waitUntil(
      self.clients.claim().then(() => {
        startUpdatePolling();
        // Run an initial update check on every activation
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
}
