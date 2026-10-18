import { onUpdateReady, onNoUpdate, applyUpdate } from './update-ui.js';
import { requestUpdateCheck, onSWMessage } from './messaging.js';
import { MESSAGE_TYPES } from '../shared/constants.js';

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
export function onUpdateApplied(callback) {
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

export { onUpdateReady, onNoUpdate, applyUpdate } from './update-ui.js';
export { requestUpdateCheck, sendToSW } from './messaging.js';
export { getCacheInfo, cleanupRuntimeCache } from './cache-manager.js';
