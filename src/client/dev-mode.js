import { logger } from './logger.js';
import { unregister } from './registration.js';
import { isDevFlag, isDevMode } from './dev-flags.js';

export { isDevFlag, isDevMode };

/**
 * Enforce dev mode by unregistering active service workers and clearing caches.
 * If the current page was controlled by an active Service Worker, reloads once
 * to ensure fresh assets are served directly from the network.
 *
 * @param {Object} [options]
 * @param {boolean} [options.reload=true] Whether to reload once if an active SW was controlling the page
 * @returns {Promise<boolean>}
 */
export async function enforceDevMode({ reload = true } = {}) {
  const host = (typeof window !== 'undefined' && window.location?.hostname) || (typeof location !== 'undefined' && location.hostname);
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    console.warn(`[NLPWA] Dev mode is active on non-localhost domain: ${host}`);
  }
  logger.info('[NLPWA] Dev mode active: Service Worker unregistered and caching disabled.');
  if (typeof window !== 'undefined') {
    window.NLPWA_DEV_ACTIVE = true;
  }
  const hadController = typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
  const unregSuccess = await unregister(undefined, { purgeCaches: true });

  if (reload && hadController && typeof window !== 'undefined') {
    const reloadKey = 'nlpwa_dev_reloaded';
    let alreadyReloaded = false;
    try {
      if (typeof sessionStorage !== 'undefined') {
        alreadyReloaded = Boolean(sessionStorage.getItem(reloadKey));
        if (!alreadyReloaded) {
          sessionStorage.setItem(reloadKey, '1');
        }
      }
    } catch {}

    if (!alreadyReloaded && window.location?.reload) {
      window.location.reload();
    }
  }

  return unregSuccess;
}
