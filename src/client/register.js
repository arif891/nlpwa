import { onUpdateReady } from './update-ui.js';
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

    // visibilitychange fires when the user switches back to this tab, which is
    // more reliable than 'focus' (which only fires when the window itself is
    // focused, missing tab switches within the same window).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastCheckAt > throttleMs) {
        lastCheckAt = now;
        requestUpdateCheck();
      }
    });
  }

  return { registration, unsubscribe };
}

export { onUpdateReady, applyUpdate } from './update-ui.js';
export { requestUpdateCheck, sendToSW } from './messaging.js';
