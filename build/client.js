/* NLPWA Client — https://github.com/your-org/nlpwa */
var NLPWAClient = (function (exports) {
  'use strict';

  /** Default cache storage names */

  /** postMessage type identifiers (SW ↔ client) */
  const MESSAGE_TYPES = {
    UPDATE_READY:   'UPDATE_READY',   // SW → client: new version available
    CHECK_UPDATE:   'CHECK_UPDATE'};

  /**
   * Send a typed message to the active Service Worker.
   *
   * @param {Object} message
   * @returns {Promise<void>}
   */
  async function sendToSW(message) {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage(message);
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
   * @param {(data: { version: string }) => void} [callback]
   * @returns {Function}  unsubscribe — call when the listening component unmounts
   */
  function onUpdateReady(callback) {
    return onSWMessage(MESSAGE_TYPES.UPDATE_READY, (data) => {
      // Dispatch CustomEvent for decoupled listeners
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-ready', {
          bubbles: true,
          detail: { version: data.version },
        })
      );

      // Direct callback
      if (typeof callback === 'function') {
        callback({ version: data.version });
      }
    });
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

    let registration;
    try {
      registration = await navigator.serviceWorker.register(swUrl);
      console.log('[NLPWA] SW registered:', registration.scope);
    } catch (err) {
      console.error('[NLPWA] SW registration failed:', err);
      return null;
    }

    // ── Update-ready handler ───────────────────────────────────────────────────
    const unsubscribe = onUpdateReady((data) => {
      if (typeof options.onUpdateReady === 'function') {
        options.onUpdateReady(data);
      }
      if (options.autoReload) {
        window.location.reload();
      }
    });

    // ── Focus-triggered update check ──────────────────────────────────────────
    // When a tab comes back into focus after a long time, check for updates.
    const focusCheck = options.checkOnFocus !== false;
    if (focusCheck) {
      const throttleMs = options.focusThrottleMs ?? 5 * 60 * 1000; // 5 min
      let lastCheckAt = 0;

      window.addEventListener('focus', () => {
        const now = Date.now();
        if (now - lastCheckAt > throttleMs) {
          lastCheckAt = now;
          requestUpdateCheck();
        }
      });
    }

    return { registration, unsubscribe };
  }

  exports.register = register;

  return exports;

})({});
