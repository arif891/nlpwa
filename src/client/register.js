import { onUpdateReady, onNoUpdate, onUpdateFailed, applyUpdate } from './update-ui.js';
import { requestUpdateCheck, onSWMessage } from './messaging.js';
import { MESSAGE_TYPES } from '../shared/constants.js';

const NON_EDITING_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio',
  'range', 'color', 'file', 'image', 'hidden',
]);

/**
 * Check if the user is currently editing an interactive element
 * (input, textarea, select, or contenteditable) to avoid discarding unsaved inputs.
 *
 * @returns {boolean}
 */
export function isUserEditing() {
  if (typeof document === 'undefined') return false;
  const activeElem = document.activeElement;
  if (!activeElem) return false;
  if (activeElem.disabled || activeElem.readOnly) return false;
  const activeTag = activeElem.tagName?.toLowerCase();
  if (activeTag === 'textarea' || activeTag === 'select' || activeElem.isContentEditable) {
    return true;
  }
  if (activeTag === 'input') {
    const type = activeElem.type?.toLowerCase();
    if (NON_EDITING_INPUT_TYPES.has(type)) {
      return false;
    }
    return true;
  }
  return false;
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
 * @param {Function} [options.onUpdateFailed]        called when SW signals update failed or hash mismatch
 * @param {Function} [options.onUpdateApplied]       called when update is committed across any tab
 * @param {Function} [options.onUpdatePrompt]        called when auto-reload is deferred due to active user editing or shouldDeferReload
 * @param {Function} [options.shouldDeferReload]     predicate ({ version, reason }) => boolean to defer reload (e.g. unsaved state, pending uploads)
 * @param {boolean}  [options.autoReload]            automatically reload on update (default: false)
 * @param {boolean}  [options.reloadOnUpdateApplied] automatically reload when another tab applies update
 * @param {boolean}  [options.checkOnFocus]          check for update when tab regains focus (default: true)
 * @param {boolean}  [options.checkOnRegister]       check for update on initial registration (default: true)
 * @param {boolean}  [options.persistentStorage]     request persistent storage via navigator.storage.persist() (default: false)
 * @param {number}   [options.focusThrottleMs]       min ms between focus-triggered checks (default: 1 hour)
 * @returns {Promise<{ registration: ServiceWorkerRegistration, unsubscribe: Function }|null>}
 */
export async function register(swUrl = '/sw.js', options = {}) {
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
      const customDefer = typeof options.shouldDeferReload === 'function'
        && Boolean(options.shouldDeferReload({ version: data?.version, reason: 'ready' }));
      const editing = isUserEditing();
      const shouldDefer = customDefer || editing;

      if (!shouldDefer) {
        applyUpdate();
      } else {
        const reason = customDefer ? 'deferred' : 'editing';
        console.warn(`[NLPWA] Auto-reload deferred (${reason}). Offering update prompt instead to protect unsaved edits.`);
        if (typeof options.onUpdatePrompt === 'function') {
          options.onUpdatePrompt({ ...data, reason });
        }
        document.dispatchEvent(
          new CustomEvent('nlpwa:update-prompt', {
            bubbles: true,
            detail: { version: data?.version, reason },
          })
        );
      }
    }
  });

  // ── Update-applied handler (cross-tab coordination) ────────────────────────
  let unsubscribeApplied = onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
    if (data?.applied === false) return;

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
      const customDefer = typeof options.shouldDeferReload === 'function'
        && Boolean(options.shouldDeferReload({ version: data?.version, reason: 'applied' }));
      const editing = isUserEditing();
      const shouldDefer = customDefer || editing;

      if (!shouldDefer) {
        window.location.reload();
      } else {
        const reason = customDefer ? 'deferred' : 'editing';
        console.warn(`[NLPWA] Reload on update-applied deferred (${reason}). Offering update prompt instead to protect unsaved edits.`);
        if (typeof options.onUpdatePrompt === 'function') {
          options.onUpdatePrompt({ version: data?.version, updateApplied: true, reason });
        } else if (typeof options.onUpdateReady === 'function') {
          options.onUpdateReady({ version: data?.version, updateApplied: true, reason });
        }
        document.dispatchEvent(
          new CustomEvent('nlpwa:update-prompt', {
            bubbles: true,
            detail: { version: data?.version, updateApplied: true, reason },
          })
        );
      }
    }
  });

  // ── No-update handler ──────────────────────────────────────────────────────
  const unsubscribeNoUpdate = onNoUpdate((data) => {
    if (typeof options.onNoUpdate === 'function') {
      options.onNoUpdate(data);
    }
  });

  // ── Update-failed handler ──────────────────────────────────────────────────
  const unsubscribeUpdateFailed = onUpdateFailed((data) => {
    if (typeof options.onUpdateFailed === 'function') {
      options.onUpdateFailed(data);
    }
  });

  // ── Focus-triggered update check ──────────────────────────────────────────
  const focusCheck = options.checkOnFocus !== false;
  let onVisibilityChange = null;
  if (focusCheck && typeof document !== 'undefined') {
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
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        requestUpdateCheck();
      }
    }, pollIntervalMs);
  }

  // ── Periodic Background Sync (if supported by browser/PWA) ────────────────
  const enablePeriodicSync = options.periodicSync !== false;
  if (enablePeriodicSync && 'periodicSync' in registration) {
    try {
      if (pollIntervalMs < 86400000) {
        console.warn('[NLPWA] Periodic Background Sync minInterval is set below 24h. Most browsers enforce a minimum interval of 12-24 hours for periodicSync.');
      }
      registration.periodicSync.register('nlpwa-update-check', {
        minInterval: pollIntervalMs,
      }).catch(() => {});
    } catch {
      // Periodic sync permission is granted by browser only for installed PWAs; ignore failure
    }
  }

  // ── Persistent Storage (if requested and supported) ────────────────────────
  if (options.persistentStorage && typeof navigator !== 'undefined' && navigator.storage?.persist) {
    navigator.storage.persist().then((persisted) => {
      if (persisted) {
        console.log('[NLPWA] Storage is persistent; browser will not evict cached resources under storage pressure.');
      } else {
        console.log('[NLPWA] Storage is best-effort; persistent storage permission was not granted.');
      }
    }).catch(() => {});
  }

  // ── Initial update check on registration ──────────────────────────────────
  // Check for updates as soon as the active service worker is ready.
  // Using postMessage triggers the check via the SW's message event,
  // where event.waitUntil() keeps the worker alive without blocking fetch events.
  const checkOnRegister = options.checkOnRegister !== false;
  let initialCheckControllerListener = null;
  if (checkOnRegister) {
    let initialCheckDone = false;
    const triggerInitialCheck = () => {
      if (initialCheckDone) return;
      initialCheckDone = true;
      if (initialCheckControllerListener) {
        navigator.serviceWorker.removeEventListener?.('controllerchange', initialCheckControllerListener);
        initialCheckControllerListener = null;
      }
      requestUpdateCheck().catch(() => {});
    };

    if (navigator.serviceWorker.controller) {
      triggerInitialCheck();
    } else {
      initialCheckControllerListener = triggerInitialCheck;
      navigator.serviceWorker.addEventListener?.('controllerchange', initialCheckControllerListener, { once: true });
      navigator.serviceWorker.ready?.then(triggerInitialCheck).catch(() => {});
    }
  }

  const unsubscribe = () => {
    unsubscribeUpdate();
    if (unsubscribeApplied) unsubscribeApplied();
    if (unsubscribeNoUpdate) unsubscribeNoUpdate();
    if (unsubscribeUpdateFailed) unsubscribeUpdateFailed();
    if (intervalTimer) clearInterval(intervalTimer);
    if (onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (initialCheckControllerListener) {
      navigator.serviceWorker.removeEventListener?.('controllerchange', initialCheckControllerListener);
    }
  };

  return { registration, unsubscribe };
}

/**
 * Unregister the NLPWA Service Worker.
 *
 * @param {string} [scope] Optional scope to target a specific registration
 * @returns {Promise<boolean>} Resolves to true if unregistration succeeded
 */
export async function unregister(scope) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const registration = scope
      ? await navigator.serviceWorker.getRegistration(scope)
      : await navigator.serviceWorker.getRegistration();
    if (registration) {
      return await registration.unregister();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Register a listener for when an update is committed/applied (in this tab or another tab).
 *
 * @param {(data: { version: string }) => void} callback
 * @returns {Function} unsubscribe function
 */
export function onUpdateApplied(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-applied', {
          bubbles: true,
          detail: { version: data?.version },
        })
      );
    }
    if (typeof callback === 'function') {
      callback({ version: data?.version });
    }
  });
}

export { onUpdateReady, onNoUpdate, onUpdateFailed, onStagingProgress, applyUpdate } from './update-ui.js';
export { requestUpdateCheck, sendToSW, requestFromSW, getVersion, getStatus } from './messaging.js';
export { getCacheInfo, cleanupRuntimeCache } from './cache-manager.js';
