import { getStaged } from '../cache/store.js';
import { checkForUpdate } from '../update/index.js';
import { logger } from '../logger.js';

/**
 * Handle browser 'backgroundfetchsuccess' event for OTA staging downloads.
 * Persists downloaded records directly into the staged cache partition
 * and triggers an update check to finalize or commit the staged release.
 *
 * @param {BackgroundFetchEvent} event
 */
export async function handleStagingBackgroundFetchSuccess(event) {
  const bgFetch = event?.registration;
  if (!bgFetch || !bgFetch.id?.startsWith('nlpwa-stage:')) return;

  try {
    const staged = await getStaged();
    if (!staged || !staged.cache) {
      logger.warn('[NLPWA] Staging Background Fetch completed but no staged cache found:', bgFetch.id);
      return;
    }
    const cache = await caches.open(staged.cache);
    const records = await bgFetch.matchAll();
    for (const record of records) {
      const response = await record.responseReady;
      if (response && response.ok) {
        await cache.put(record.request, response);
        logger.log(`[NLPWA] Stored Background Fetch record in staged cache (${staged.cache}):`, record.request.url || record.request);
      }
    }
    await checkForUpdate();
  } catch (err) {
    logger.warn('[NLPWA] Error handling staging background fetch completion:', err?.message || err);
  }
}
