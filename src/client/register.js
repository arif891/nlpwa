import { onUpdateReady, applyUpdate } from './update-ui.js';
import { requestUpdateCheck } from './messaging.js';

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

export { onUpdateReady, applyUpdate } from './update-ui.js';
export { requestUpdateCheck, sendToSW } from './messaging.js';
