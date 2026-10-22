import { checkForUpdate } from '../update/index.js';
import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Handle periodic background sync events.
 *
 * Dispatches to internal update checker on 'nlpwa-update-check'
 * and forwards custom tags to configured plugins (e.g. PeriodicSyncPlugin).
 *
 * @param {Event} event
 */
export function handleSync(event) {
  if (event.tag === 'nlpwa-update-check') {
    event.waitUntil(checkForUpdate());
  }

  let activeConfig = {};
  try {
    activeConfig = getConfig() || {};
  } catch {
    activeConfig = {};
  }

  const plugins = Array.isArray(activeConfig.plugins) ? activeConfig.plugins : [];

  for (const plugin of plugins) {
    if (typeof plugin?.onPeriodicSync === 'function') {
      try {
        const res = plugin.onPeriodicSync(event);
        if (res && typeof res.then === 'function') {
          event.waitUntil(res);
        }
      } catch (err) {
        logger.warn('[NLPWA] plugin.onPeriodicSync error:', err?.message || err);
      }
    }
  }

  if (typeof activeConfig.onPeriodicSync === 'function') {
    try {
      const res = activeConfig.onPeriodicSync(event);
      if (res && typeof res.then === 'function') {
        event.waitUntil(res);
      }
    } catch (err) {
      logger.warn('[NLPWA] onPeriodicSync handler error:', err?.message || err);
    }
  }
}
