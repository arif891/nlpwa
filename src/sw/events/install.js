import { logger } from '../logger.js';
import { precacheFiles } from '../cache/install.js';

/**
 * Service Worker install event handler.
 *
 * @param {Object} config
 * @returns {(event: ExtendableEvent) => void}
 */
export function handleInstall(config) {
  return (event) => {
    logger.log(`[NLPWA] Installing SW v${config.version}`);
    event.waitUntil(
      (async () => {
        try {
          const result = await precacheFiles();
          if (!result || result.status !== 'incomplete') {
            await self.skipWaiting();
          }
        } catch (err) {
          logger.error('[NLPWA] Install error:', err);
          throw err;
        }
      })()
    );
  };
}
