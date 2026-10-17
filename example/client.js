/* NLPWA Client — https://github.com/arif891/nlpwa */
var NLPWAClient = (function (exports) {
  'use strict';

  /** Default cache storage names */

  /** postMessage type identifiers (SW ↔ client) */
  const MESSAGE_TYPES = {
    UPDATE_READY:   'UPDATE_READY',   // SW → client: new version available
    CHECK_UPDATE:   'CHECK_UPDATE',   // client → SW: trigger manual check
    UPDATE_APPLIED: 'UPDATE_APPLIED', // SW → client: reply to APPLY_UPDATE ({ applied })
    NO_UPDATE:      'NO_UPDATE',      // SW → client: already up to date
    APPLY_UPDATE:   'APPLY_UPDATE',   // client → SW: switch to the staged update now
  };

  /**
   * Send a typed message to the active Service Worker.
   *
   * @param {Object} message
   * @returns {Promise<void>}
   */
  async function sendToSW(message) {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const sw = navigator.serviceWorker.controller || registration.active;
    sw?.postMessage(message);
  }

  /**
   * Listen for typed messages from the Service Worker.
   *
   * @param {string}   type     one of MESSAGE_TYPES
   * @param {Function} handler  called with the full message data object
   * @returns {Function}        call to unsubscribe
   */
  function onSWMessage(type, handler) {
    const listener = (event) => {
      if (event.data?.type === type) handler(event.data);
    };
    navigator.serviceWorker.addEventListener('message', listener);
    return () => navigator.serviceWorker.removeEventListener('message', listener);
  }

  /**
   * Trigger a manual update check from the client side.
   * The SW will respond with UPDATE_READY or NO_UPDATE.
   *
   * @returns {Promise<void>}
   */
  function requestUpdateCheck() {
    return sendToSW({ type: MESSAGE_TYPES.CHECK_UPDATE });
  }

  /**
   * Register a handler to be called when the SW signals an update is ready.
   *
   * Also fires a `nlpwa:update-ready` CustomEvent on `document` so any part
   * of the app can listen without importing this module directly:
   *
   *   document.addEventListener('nlpwa:update-ready', (e) => {
   *     console.log('New version:', e.detail.version);
   *   });
   *
   * @param {(data: { version: string, partial: boolean }) => void} [callback]
   * @returns {Function}  unsubscribe — call when the listening component unmounts
   */
  function onUpdateReady(callback) {
    return onSWMessage(MESSAGE_TYPES.UPDATE_READY, (data) => {
      // Dispatch CustomEvent for decoupled listeners
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-ready', {
          bubbles: true,
          detail: { version: data.version, partial: Boolean(data.partial) },
        })
      );

      // Direct callback
      if (typeof callback === 'function') {
        callback({ version: data.version, partial: Boolean(data.partial) });
      }
    });
  }

  /**
   * Switch to the staged update, then reload the page.
   *
   * The SW builds updates in the background and only makes them live on a page
   * load. This asks it to switch right now (it replies UPDATE_APPLIED), then
   * reloads. If the SW doesn't answer within `timeoutMs` the page reloads
   * anyway, because a reload is itself a navigation that triggers the switch.
   *
   * Call this from your update prompt's "Refresh" button.
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>}
   */
  async function applyUpdate({ timeoutMs = 3000 } = {}) {
    try {
      let off = () => {};
      const reply = new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        off = onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, () => { clearTimeout(timer); resolve(); });
      });
      await sendToSW({ type: MESSAGE_TYPES.APPLY_UPDATE });
      await reply;
      off();
    } catch {
      // no service worker available - fall through to the reload
    }
    window.location.reload();
  }

  /**
   * Register the NLPWA Service Worker and set up update handling.
   *
   * Usage (in your main client JS):
   *
   *   import { register } from './nlpwa/src/client/register.js';
   *   // or from the built file: <script src="/nlpwa.client.js"></script>
   *
   *   NLPWAClient.register('/sw.js', {
   *     onUpdateReady: ({ version }) => {
   *       showBanner(`Version ${version} is ready — click to refresh.`);
   *     },
   *   });
   *
   * @param {string} swUrl  path to the bundled sw.js  (default: '/sw.js')
   * @param {Object} options
   * @param {Function} [options.onUpdateReady]   called when SW signals update ready
   * @param {boolean}  [options.autoReload]      automatically reload on update (default: false)
   * @param {boolean}  [options.checkOnFocus]    check for update when tab regains focus (default: true)
   * @param {number}   [options.focusThrottleMs] min ms between focus-triggered checks (default: 5 min)
   * @returns {Promise<{ registration: ServiceWorkerRegistration, unsubscribe: Function }|null>}
   */
  async function register(swUrl = '/sw.js', options = {}) {
    if (!('serviceWorker' in navigator)) {
      console.warn('[NLPWA] Service Workers are not supported in this browser.');
      return null;
    }

    const regOptions = {};
    if (options.type) regOptions.type = options.type;
    if (options.scope) regOptions.scope = options.scope;
    if (options.updateViaCache) regOptions.updateViaCache = options.updateViaCache;

    let registration;
    try {
      registration = await navigator.serviceWorker.register(swUrl, regOptions);
      console.log('[NLPWA] SW registered:', registration.scope);
    } catch (err) {
      console.error('[NLPWA] SW registration failed:', err);
      return null;
    }

    // ── Update-ready handler ───────────────────────────────────────────────────
    const unsubscribeUpdate = onUpdateReady((data) => {
      if (typeof options.onUpdateReady === 'function') {
        options.onUpdateReady(data);
      }
      if (options.autoReload) {
        // Don't auto-reload if user is actively typing in an input to prevent data loss
        const activeTag = document.activeElement?.tagName?.toLowerCase();
        const isEditing = activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable;
        if (!isEditing) {
          applyUpdate();
        } else {
          console.warn('[NLPWA] Auto-reload deferred: active input focused.');
        }
      }
    });

    // ── Focus-triggered update check ──────────────────────────────────────────
    const focusCheck = options.checkOnFocus !== false;
    let onVisibilityChange = null;
    if (focusCheck) {
      const throttleMs = options.focusThrottleMs ?? 5 * 60 * 1000; // 5 min
      let lastCheckAt = 0;

      onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - lastCheckAt > throttleMs) {
          lastCheckAt = now;
          requestUpdateCheck();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // ── Client-side update polling interval ───────────────────────────────────
    // Service Workers can be terminated while idle, making setInterval inside the SW
    // unreliable. Running periodic checks from active client tabs ensures updates are detected.
    const pollIntervalMs = options.pollIntervalMs ?? 60 * 60 * 1000; // 1 hour default
    let intervalTimer = null;
    if (pollIntervalMs > 0) {
      intervalTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          requestUpdateCheck();
        }
      }, pollIntervalMs);
    }

    // ── Periodic Background Sync (if supported by browser/PWA) ────────────────
    if ('periodicSync' in registration) {
      try {
        await registration.periodicSync.register('nlpwa-update-check', {
          minInterval: pollIntervalMs,
        });
      } catch {
        // Periodic sync permission is granted by browser only for installed PWAs; ignore failure
      }
    }

    const unsubscribe = () => {
      unsubscribeUpdate();
      if (intervalTimer) clearInterval(intervalTimer);
      if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
    };

    return { registration, unsubscribe };
  }

  exports.applyUpdate = applyUpdate;
  exports.onUpdateReady = onUpdateReady;
  exports.register = register;
  exports.requestUpdateCheck = requestUpdateCheck;
  exports.sendToSW = sendToSW;

  return exports;

})({});
