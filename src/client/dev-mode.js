import { logger } from './logger.js';
import { unregister } from './registration.js';
import { isDevFlag } from './dev-flags.js';

export { isDevFlag };

/**
 * Check if development / UI design mode is active.
 *
 * Checks in priority order:
 * 1. Explicit options: { dev: true }
 * 2. Window global: window.NLPWA_DEV === true (or "true", 1, "1")
 * 3. Window config: window.NLPWA_CONFIG.dev === true
 * 4. Script tag: <script src="client.js" data-dev="true"> or data-dev
 * 5. Optional remote probe: only when explicitly opted in via options.probeRemote
 *
 * Note: Remote probing is never performed on normal page load to avoid blocking SW registration
 * or paying network penalties in production.
 *
 * @param {HTMLScriptElement} [script]
 * @param {Object} [options]
 * @param {boolean|string|number} [options.dev]
 * @param {boolean} [options.probeRemote]
 * @param {number} [options.probeTimeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isDevMode(script, options = {}) {
  // 1. Explicit options flag
  if (isDevFlag(options.dev)) {
    return true;
  }

  // 2. Global window.NLPWA_DEV or window.NLPWA_CONFIG.dev
  if (typeof window !== 'undefined') {
    if (isDevFlag(window.NLPWA_DEV)) {
      return true;
    }
    if (window.NLPWA_CONFIG && isDevFlag(window.NLPWA_CONFIG.dev)) {
      return true;
    }
  }

  // 3. Script tag attribute: data-dev, data-dev="true", data-dev="1"
  if (script) {
    const devAttr = script.getAttribute?.('data-dev');
    if (devAttr !== null && devAttr !== undefined) {
      if (isDevFlag(devAttr)) {
        return true;
      }
    }
  }

  // 4. Optional remote config probe (only when explicitly requested via options.probeRemote)
  if (options.probeRemote && typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const baseConfigUrl = window.NLPWA_CONFIG_URL
        || script?.getAttribute?.('data-config')
        || '/api/update/config.json';
      const sep = baseConfigUrl.includes('?') ? '&' : '?';
      const configUrl = `${baseConfigUrl}${sep}nlpwa_dev=1`;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = options.probeTimeoutMs || 1500;
      const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
      try {
        const res = await fetch(configUrl, {
          cache: 'no-store',
          headers: { 'X-NLPWA-Dev-Check': '1' },
          signal: controller?.signal,
        });
        if (res.ok) {
          const config = await res.json();
          if (config && isDevFlag(config.dev)) {
            return true;
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // Non-fatal: offline or timeout
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
