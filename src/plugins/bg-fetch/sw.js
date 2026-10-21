import { BG_FETCH_CACHE_NAME, BG_FETCH_MESSAGE_TYPES } from './constants.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('NLPWA:BgFetch');

export { BG_FETCH_CACHE_NAME, BG_FETCH_MESSAGE_TYPES };

/**
 * Handle successful background fetch by persisting all downloaded records
 * into the destination cache storage and notifying open client windows.
 *
 * @param {BackgroundFetchEvent} event
 * @param {{ cacheName?: string }} [options]
 */
export async function handleBackgroundFetchSuccess(event, { cacheName = BG_FETCH_CACHE_NAME } = {}) {
  const bgFetch = event.registration;
  try {
    const cache = await caches.open(cacheName);
    const records = await bgFetch.matchAll();

    const storedRequests = [];
    for (const record of records) {
      try {
        const response = await record.responseReady;
        if (response && response.ok) {
          await cache.put(record.request, response);
          storedRequests.push(typeof record.request === 'string' ? record.request : record.request.url);
        }
      } catch (err) {
        logger.warn(`[NLPWA] Failed to cache record in background fetch ${bgFetch.id}:`, err?.message || err);
      }
    }

    logger.log(`[NLPWA] Background fetch "${bgFetch.id}" succeeded: stored ${storedRequests.length} asset(s).`);

    // Notify clients
    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: BG_FETCH_MESSAGE_TYPES.BG_FETCH_SUCCESS,
          id: bgFetch.id,
          count: storedRequests.length,
          cacheName,
          storedRequests,
        });
      }
    }
  } catch (err) {
    logger.error(`[NLPWA] Error handling background fetch success for ${bgFetch.id}:`, err);
  }
}

/**
 * Handle failed background fetch.
 *
 * @param {BackgroundFetchEvent} event
 */
export async function handleBackgroundFetchFail(event) {
  const bgFetch = event.registration;
  logger.warn(`[NLPWA] Background fetch "${bgFetch.id}" failed: ${bgFetch.failureReason}`);

  if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({
        type: BG_FETCH_MESSAGE_TYPES.BG_FETCH_FAIL,
        id: bgFetch.id,
        failureReason: bgFetch.failureReason,
      });
    }
  }
}

/**
 * Handle aborted background fetch.
 *
 * @param {BackgroundFetchEvent} event
 */
export async function handleBackgroundFetchAbort(event) {
  const bgFetch = event.registration;
  logger.log(`[NLPWA] Background fetch "${bgFetch.id}" aborted.`);

  if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({
        type: BG_FETCH_MESSAGE_TYPES.BG_FETCH_ABORT,
        id: bgFetch.id,
      });
    }
  }
}

/**
 * Handle notification click on background fetch task.
 *
 * @param {BackgroundFetchEvent} event
 * @param {{ clickUrl?: string }} [options]
 */
export async function handleBackgroundFetchClick(event, { clickUrl = '/' } = {}) {
  const bgFetch = event.registration;
  if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0 && typeof clients[0].focus === 'function') {
      await clients[0].focus();
      return;
    }
    if (typeof self.clients.openWindow === 'function') {
      await self.clients.openWindow(clickUrl);
    }
  }
}

/**
 * Setup background fetch event listeners on the service worker global.
 *
 * @param {Object} [options]
 */
export function setupBackgroundFetchListeners(options = {}) {
  if (typeof self === 'undefined') return;

  self.addEventListener('backgroundfetchsuccess', (event) => {
    event.waitUntil(handleBackgroundFetchSuccess(event, options));
  });

  self.addEventListener('backgroundfetchfail', (event) => {
    event.waitUntil(handleBackgroundFetchFail(event));
  });

  self.addEventListener('backgroundfetchabort', (event) => {
    event.waitUntil(handleBackgroundFetchAbort(event));
  });

  self.addEventListener('backgroundfetchclick', (event) => {
    event.waitUntil(handleBackgroundFetchClick(event, options));
  });
}

/**
 * Background Fetch Service Worker Plugin.
 */
export class BackgroundFetchPlugin {
  constructor(options = {}) {
    this.options = options;
    setupBackgroundFetchListeners(options);
  }
}
