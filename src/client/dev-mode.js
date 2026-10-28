import { logger } from './logger.js';
import { unregister } from './registration.js';
import { isDevFlag } from './dev-flags.js';

export { isDevFlag };

/**
 * Check if development / UI design mode is active.
 *
 * Checks in priority order:
 * 1. Window global: window.NLPWA_DEV === true (or "true")
 * 2. Script tag: <script src="client.js" data-dev="true"> or data-dev
 *
 * @param {HTMLScriptElement} [script]
 * @returns {Promise<boolean>}
 */
export async function isDevMode(script) {
  // 1. Global window.NLPWA_DEV
  if (typeof window !== 'undefined' && isDevFlag(window.NLPWA_DEV)) {
    return true;
  }

  // 2. Script tag attribute: data-dev, data-dev="true"
  if (script) {
    const devAttr = script.getAttribute?.('data-dev');
    if (devAttr !== null && devAttr !== undefined) {
      if (isDevFlag(devAttr)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Enforce dev mode by unregistering active service workers and clearing caches.
 *
 * @returns {Promise<boolean>}
 */
export async function enforceDevMode() {
  logger.info('[NLPWA] Dev mode active: Service Worker unregistered and caching disabled.');
  if (typeof window !== 'undefined') {
    window.NLPWA_DEV_ACTIVE = true;
  }
  return await unregister();
}
