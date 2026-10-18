/* NLPWA Client — https://github.com/arif891/nlpwa */
var NLPWAClient = (function (exports) {
  'use strict';

  /** Default cache storage names */

  /** postMessage type identifiers (SW ↔ client) */
  const MESSAGE_TYPES = {
    UPDATE_READY:    'UPDATE_READY',    // SW → client: new version available
    CHECK_UPDATE:    'CHECK_UPDATE',    // client → SW: trigger manual check
    UPDATE_APPLIED:  'UPDATE_APPLIED',  // SW → client: reply to APPLY_UPDATE ({ applied })
    NO_UPDATE:       'NO_UPDATE',       // SW → client: already up to date
    APPLY_UPDATE:    'APPLY_UPDATE',    // client → SW: switch to the staged update now
    GET_CACHE_INFO:  'GET_CACHE_INFO',  // client → SW: request storage quota & cache metrics
    CACHE_INFO:      'CACHE_INFO',      // SW → client: reply with quota & cache metrics
    CLEANUP_RUNTIME: 'CLEANUP_RUNTIME', // client → SW: request runtime cache cleanup
    RUNTIME_CLEANED: 'RUNTIME_CLEANED', // SW → client: reply with cleanup results
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
   * Register a handler to be called when the SW signals that the app is already up to date.
   *
   * Also fires a `nlpwa:no-update` CustomEvent on `document` so any part
   * of the app can listen without importing this module directly:
   *
   *   document.addEventListener('nlpwa:no-update', (e) => {
   *     console.log('Already on latest version:', e.detail.version);
   *   });
   *
   * @param {(data: { version: string }) => void} [callback]
   * @returns {Function}  unsubscribe
   */
  function onNoUpdate(callback) {
    return onSWMessage(MESSAGE_TYPES.NO_UPDATE, (data) => {
      document.dispatchEvent(
        new CustomEvent('nlpwa:no-update', {
          bubbles: true,
          detail: { version: data.version },
        })
      );

      if (typeof callback === 'function') {
        callback({ version: data.version });
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
   * @param {{ timeoutMs?: number, reload?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async function applyUpdate({ timeoutMs = 3000, reload = true } = {}) {
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
    document.dispatchEvent(
      new CustomEvent('nlpwa:update-applied', { bubbles: true })
    );
    if (reload) {
      window.location.reload();
    }
  }

  /**
   * Send a request message to the active Service Worker and await a response.
   * Uses MessageChannel when supported for dedicated 1-to-1 reply, with fallback
   * to navigator.serviceWorker message event listener.
   *
   * @param {string} type
   * @param {Object} [payload]
   * @param {string} [replyType]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  async function requestFromSW(type, payload = {}, replyType = '', timeoutMs = 5000) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      throw new Error('[NLPWA] Service Workers are not supported in this environment.');
    }

    const registration = await navigator.serviceWorker.ready;
    const sw = navigator.serviceWorker.controller || registration.active;
    if (!sw) {
      throw new Error('[NLPWA] No active Service Worker controller found.');
    }

    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // 1. MessageChannel for direct 1-to-1 reply (standard in modern browsers)
    if (typeof MessageChannel !== 'undefined') {
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
          channel.port1.close();
          reject(new Error(`[NLPWA] Request timed out after ${timeoutMs}ms (${type})`));
        }, timeoutMs);

        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          channel.port1.close();
          if (event.data?.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data?.data ?? event.data);
          }
        };

        sw.postMessage({ type, requestId, ...payload }, [channel.port2]);
      });
    }

    // 2. Fallback via global navigator.serviceWorker message event listener
    return new Promise((resolve, reject) => {
      let timer;
      const listener = (event) => {
        if (
          (event.data?.type === replyType || event.data?.type === type) &&
          (!event.data?.requestId || event.data.requestId === requestId)
        ) {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message', listener);
          if (event.data?.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data?.data ?? event.data);
          }
        }
      };

      timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', listener);
        reject(new Error(`[NLPWA] Request timed out after ${timeoutMs}ms (${type})`));
      }, timeoutMs);

      navigator.serviceWorker.addEventListener('message', listener);
      sw.postMessage({ type, requestId, ...payload });
    });
  }

  /**
   * Request storage quota and runtime cache usage metrics from the Service Worker.
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{
   *   quota: number|null,
   *   usage: number|null,
   *   percentUsed: number|null,
   *   remaining: number|null,
   *   runtimeEntries: number,
   *   runtimeBytes: number,
   *   largestEntries: Array<{ url: string, size: number, cachedAt: number }>
   * }>}
   */
  async function getCacheInfo({ timeoutMs = 3000 } = {}) {
    return requestFromSW(MESSAGE_TYPES.GET_CACHE_INFO, {}, MESSAGE_TYPES.CACHE_INFO, timeoutMs);
  }

  /**
   * Request cleanup on the runtime cache.
   *
   * Supported options:
   * - strategy: 'largest' | 'lru' | 'max-age' | 'quota' | 'pattern' | 'all' (default: 'lru')
   * - maxItemBytes: evict any individual file larger than this byte size
   * - minItemBytes: evict any individual file with size >= this byte size
   * - maxTotalBytes: evict entries until total runtime cache size is <= this limit
   * - maxEntries: evict entries until total remaining count is <= this limit
   * - maxAgeMs: evict entries older than this age in ms
   * - maxQuotaPercent: for 'quota' strategy, evict until usage percentage is <= this value
   * - maxQuotaBytes: for 'quota' strategy, evict until total usage is <= this value
   * - preferLargest: for 'quota' strategy, evict largest entries first (default: true)
   * - match: glob pattern to match URLs to evict (for 'pattern' strategy)
   * - count: limit maximum number of items to evict
   *
   * @param {Object} [cleanupOptions]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{
   *   success: boolean,
   *   strategy: string,
   *   evictedCount: number,
   *   evictedUrls: string[],
   *   freedBytes: number,
   *   remainingEntries: number,
   *   remainingBytes: number,
   *   quota: Object
   * }>}
   */
  async function cleanupRuntimeCache(cleanupOptions = {}, { timeoutMs = 10000 } = {}) {
    return requestFromSW(
      MESSAGE_TYPES.CLEANUP_RUNTIME,
      { options: cleanupOptions },
      MESSAGE_TYPES.RUNTIME_CLEANED,
      timeoutMs
    );
  }

  /**
   * Register the NLPWA Service Worker and set up update handling.
   *
   * Usage (in your main client JS):
   *
   *   import { register } from 'nlpwa/client';
   *   // or from the built file: <script src="/client.js"></script>
   *
   *   NLPWAClient.register('/sw.js', {
   *     onUpdateReady: ({ version }) => {
   *       showBanner(`Version ${version} is ready — click to refresh.`);
   *     },
   *     onNoUpdate: ({ version }) => {
   *       console.log(`Already up to date at version ${version}`);
   *     },
   *   });
   *
   * @param {string} swUrl  path to the bundled sw.js  (default: '/sw.js')
   * @param {Object} options
   * @param {Function} [options.onUpdateReady]         called when SW signals update ready
   * @param {Function} [options.onNoUpdate]            called when SW signals already up to date
   * @param {Function} [options.onUpdateApplied]       called when update is committed across any tab
   * @param {boolean}  [options.autoReload]            automatically reload on update (default: false)
   * @param {boolean}  [options.reloadOnUpdateApplied] automatically reload when another tab applies update
   * @param {boolean}  [options.checkOnFocus]          check for update when tab regains focus (default: true)
   * @param {number}   [options.focusThrottleMs]       min ms between focus-triggered checks (default: 1 hour)
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
        const activeElem = typeof document !== 'undefined' ? document.activeElement : null;
        const activeTag = activeElem?.tagName?.toLowerCase();
        const isEditing = activeTag === 'input' || activeTag === 'textarea' || activeElem?.isContentEditable;
        if (!isEditing) {
          applyUpdate();
        } else {
          console.warn('[NLPWA] Auto-reload deferred: active input focused.');
          const onFinishEditing = () => {
            activeElem?.removeEventListener('blur', onFinishEditing);
            activeElem?.removeEventListener('change', onFinishEditing);
            console.log('[NLPWA] Input focus cleared, applying deferred reload.');
            applyUpdate();
          };
          activeElem?.addEventListener('blur', onFinishEditing, { once: true });
          activeElem?.addEventListener('change', onFinishEditing, { once: true });
        }
      }
    });

    // ── Update-applied handler (cross-tab coordination) ────────────────────────
    let unsubscribeApplied = onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-applied', {
          bubbles: true,
          detail: { version: data?.version },
        })
      );
      if (typeof options.onUpdateApplied === 'function') {
        options.onUpdateApplied(data);
      }
      if (options.reloadOnUpdateApplied || options.autoReload) {
        const activeElem = typeof document !== 'undefined' ? document.activeElement : null;
        const activeTag = activeElem?.tagName?.toLowerCase();
        const isEditing = activeTag === 'input' || activeTag === 'textarea' || activeElem?.isContentEditable;
        if (!isEditing) {
          window.location.reload();
        } else {
          console.warn('[NLPWA] Reload on update-applied deferred: active input focused.');
          const onFinishEditing = () => {
            activeElem?.removeEventListener('blur', onFinishEditing);
            activeElem?.removeEventListener('change', onFinishEditing);
            window.location.reload();
          };
          activeElem?.addEventListener('blur', onFinishEditing, { once: true });
          activeElem?.addEventListener('change', onFinishEditing, { once: true });
        }
      }
    });

    // ── No-update handler ──────────────────────────────────────────────────────
    let unsubscribeNoUpdate = null;
    if (typeof options.onNoUpdate === 'function') {
      unsubscribeNoUpdate = onNoUpdate(options.onNoUpdate);
    }

    // ── Focus-triggered update check ──────────────────────────────────────────
    const focusCheck = options.checkOnFocus !== false;
    let onVisibilityChange = null;
    if (focusCheck) {
      const throttleMs = options.focusThrottleMs ?? 60 * 60 * 1000; // 1 hour
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
        if (pollIntervalMs < 86400000) {
          console.warn('[NLPWA] Periodic Background Sync minInterval is set below 24h. Most browsers enforce a minimum interval of 12-24 hours for periodicSync.');
        }
        await registration.periodicSync.register('nlpwa-update-check', {
          minInterval: pollIntervalMs,
        });
      } catch {
        // Periodic sync permission is granted by browser only for installed PWAs; ignore failure
      }
    }

    const unsubscribe = () => {
      unsubscribeUpdate();
      if (unsubscribeApplied) unsubscribeApplied();
      if (unsubscribeNoUpdate) unsubscribeNoUpdate();
      if (intervalTimer) clearInterval(intervalTimer);
      if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
    };

    return { registration, unsubscribe };
  }

  /**
   * Register a listener for when an update is committed/applied (in this tab or another tab).
   *
   * @param {(data: { version: string }) => void} callback
   * @returns {Function} unsubscribe function
   */
  function onUpdateApplied(callback) {
    return onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-applied', {
          bubbles: true,
          detail: { version: data?.version },
        })
      );
      if (typeof callback === 'function') {
        callback({ version: data?.version });
      }
    });
  }

  exports.applyUpdate = applyUpdate;
  exports.cleanupRuntimeCache = cleanupRuntimeCache;
  exports.getCacheInfo = getCacheInfo;
  exports.onNoUpdate = onNoUpdate;
  exports.onUpdateApplied = onUpdateApplied;
  exports.onUpdateReady = onUpdateReady;
  exports.register = register;
  exports.requestUpdateCheck = requestUpdateCheck;
  exports.sendToSW = sendToSW;

  return exports;

})({});
