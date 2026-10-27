import { logger } from './logger.js';
import { unregister } from './registration.js';

/**
 * Check if development / UI design mode is active.
 *
 * Checks in priority order:
 * 1. Explicit options: { dev: true }
 * 2. Window global: window.NLPWA_DEV === true (or "true", 1)
 * 3. Window config: window.NLPWA_CONFIG.dev === true
 * 4. Script tag: <script src="client.js" data-dev="true"> or data-dev
 * 5. Runtime config.json: fetch /api/update/config.json with { cache: 'no-store' }
 *
 * @param {HTMLScriptElement} [script]
 * @param {Object} [options]
 * @returns {Promise<boolean>}
 */
export async function isDevMode(script, options = {}) {
  // 1. Explicit options flag
  if (options.dev === true || options.dev === 'true' || options.dev === 1) {
    return true;
  }

  // 2. Global window.NLPWA_DEV
  if (typeof window !== 'undefined') {
    if (window.NLPWA_DEV === true || window.NLPWA_DEV === 'true' || window.NLPWA_DEV === 1) {
      return true;
    }
    if (window.NLPWA_CONFIG && (window.NLPWA_CONFIG.dev === true || window.NLPWA_CONFIG.dev === 'true')) {
      return true;
    }
  }

  // 3. Script tag attribute: data-dev="true" or data-dev
  if (script) {
    const devAttr = script.getAttribute?.('data-dev');
    const hasDevAttr = typeof script.hasAttribute === 'function'
      ? script.hasAttribute('data-dev')
      : (devAttr !== null && devAttr !== undefined);
    if (devAttr === 'true' || devAttr === '' || hasDevAttr) {
      return true;
    }
  }

  // 4. Check runtime config.json (generated from nlpwa.config.js dev: true)
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const baseConfigUrl = window.NLPWA_CONFIG_URL
        || script?.getAttribute?.('data-config')
        || '/api/update/config.json';
      const sep = baseConfigUrl.includes('?') ? '&' : '?';
      const configUrl = `${baseConfigUrl}${sep}nlpwa_dev=1`;
      const res = await fetch(configUrl, {
        cache: 'no-store',
        headers: { 'X-NLPWA-Dev-Check': '1' },
      });
      if (res.ok) {
        const config = await res.json();
        if (config && (config.dev === true || config.dev === 'true' || config.dev === 1)) {
          return true;
        }
      }
    } catch {
      // Non-fatal: if server is unreachable or doesn't have config.json, continue normally
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
