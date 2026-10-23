import { BG_FETCH_CACHE_NAME, BG_FETCH_MESSAGE_TYPES } from './constants.js';
import { createLogger } from '../../shared/logger.js';
import { isManifestFile, matchRoute } from '../../sw/fetch/router.js';
import { openActive } from '../../sw/cache/meta/active.js';
import { getConfig } from '../../sw/config/index.js';

const logger = createLogger('NLPWA:BgFetch');

function getEffectiveConfig(options = {}) {
  if (options.config && Object.keys(options.config).length > 0) {
    return options.config;
  }
  try {
    return getConfig() || {};
  } catch {
    return (typeof self !== 'undefined' && self.__NLPWA_CONFIG__) ? self.__NLPWA_CONFIG__ : {};
  }
}

export { BG_FETCH_CACHE_NAME, BG_FETCH_MESSAGE_TYPES };

/**
 * Resolve the target Cache instance and name for a given request,
 * adhering to info.json precache rules, route definitions, or defaulting to runtime cache.
 *
 * @param {Request|string} request
 * @param {Object} [options]
 * @returns {Promise<{ cache: Cache, cacheName: string }>}
 */
export async function resolveTargetCache(request, options = {}) {
  // If an explicit non-default cacheName was passed to the plugin/handler, respect it
  if (options.cacheName && options.cacheName !== 'runtime' && options.cacheName !== 'nlpwa-bg-fetch') {
    return {
      cache: await caches.open(options.cacheName),
      cacheName: options.cacheName,
    };
  }

  const config = getEffectiveConfig(options);

  const rawUrl = typeof request === 'string' ? request : request.url;
  let parsedUrl = null;
  try {
    const origin = (typeof self !== 'undefined' && self.location) ? self.location.origin : 'http://localhost';
    parsedUrl = new URL(rawUrl, origin);
  } catch {}

  // 1. Is it a manifest/precache file from info.json?
  if (parsedUrl && isManifestFile(parsedUrl, config)) {
    const offlinePrefix = config.caches?.offline || 'offline';
    try {
      const activeCache = await openActive(offlinePrefix);
      if (activeCache) {
        return { cache: activeCache, cacheName: offlinePrefix };
      }
    } catch {}
    return {
      cache: await caches.open(offlinePrefix),
      cacheName: offlinePrefix,
    };
  }

  // 2. Check if a route in config.routes matches this URL
  if (parsedUrl && Array.isArray(config.routes)) {
    const matchedRoute = matchRoute(parsedUrl, config.routes, config);
    if (matchedRoute) {
      const customCacheName = matchedRoute.cacheName || matchedRoute.options?.cacheName;
      if (customCacheName) {
        return {
          cache: await caches.open(customCacheName),
          cacheName: customCacheName,
        };
      }
    }
  }

  // 3. Default to runtime cache!
  const defaultRuntimeName = config.caches?.runtime || options.cacheName || BG_FETCH_CACHE_NAME;
  return {
    cache: await caches.open(defaultRuntimeName),
    cacheName: defaultRuntimeName,
  };
}

/**
 * Handle successful background fetch by persisting all downloaded records
 * into the destination cache storage and notifying open client windows.
 *
 * @param {BackgroundFetchEvent} event
 * @param {{ cacheName?: string, config?: Object }} [options]
 */
export async function handleBackgroundFetchSuccess(event, options = {}) {
  const bgFetch = event.registration;
  try {
    const records = await bgFetch.matchAll();

    const storedRequests = [];
    const usedCacheNames = new Set();
    const uploadResults = [];
    const config = getEffectiveConfig(options);
    const largeThreshold = config.largeFileThresholdBytes ?? (25 * 1024 * 1024);

    for (const record of records) {
      try {
        let response = await record.responseReady;
        if (response && response.ok) {
          const rawUrl = typeof record.request === 'string' ? record.request : record.request.url;
          const method = (typeof record.request === 'object' && record.request.method)
            ? record.request.method.toUpperCase()
            : 'GET';

          if (method === 'GET') {
            const { cache, cacheName } = await resolveTargetCache(record.request, options);

            // Stream response directly to native CacheStorage on disk without buffering in JS heap
            await cache.put(record.request, response);
            usedCacheNames.add(cacheName);
            storedRequests.push(rawUrl);
          } else {
            // Upload request (POST/PUT/PATCH): CacheStorage does not support non-GET requests.
            // Extract the server's reply payload to return to client listeners.
            let responseData = null;
            try {
              const text = await response.text();
              try {
                responseData = JSON.parse(text);
              } catch {
                responseData = text;
              }
            } catch {}

            uploadResults.push({
              url: rawUrl,
              method,
              status: response.status,
              response: responseData,
            });
          }
        }
      } catch (err) {
        logger.warn(`[NLPWA] Failed to process record in background fetch ${bgFetch.id}:`, err?.message || err);
      }
    }

    // Update native OS notification via BackgroundFetchUpdateUIEvent
    if (typeof event.updateUI === 'function') {
      try {
        const isUploadOnly = uploadResults.length > 0 && storedRequests.length === 0;
        const defaultTitle = isUploadOnly ? 'Upload complete' : 'Download complete';
        await event.updateUI({
          title: options.title || options.successTitle || defaultTitle,
          icons: options.icons || options.successIcons,
        });
      } catch (uiErr) {
        logger.debug('[NLPWA] updateUI error on success:', uiErr?.message || uiErr);
      }
    }

    const primaryCacheName = usedCacheNames.values().next().value || BG_FETCH_CACHE_NAME;

    // Notify clients
    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: BG_FETCH_MESSAGE_TYPES.BG_FETCH_SUCCESS,
          id: bgFetch.id,
          count: storedRequests.length,
          cacheName: primaryCacheName,
          caches: Array.from(usedCacheNames),
          storedRequests,
          uploadResults,
          isUpload: uploadResults.length > 0 && storedRequests.length === 0,
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
 * @param {Object} [options]
 */
export async function handleBackgroundFetchFail(event, options = {}) {
  const bgFetch = event.registration;
  logger.warn(`[NLPWA] Background fetch "${bgFetch.id}" failed: ${bgFetch.failureReason}`);

  // Update native OS notification via BackgroundFetchUpdateUIEvent
  if (typeof event.updateUI === 'function') {
    try {
      await event.updateUI({
        title: options.failTitle || 'Transfer failed',
      });
    } catch (uiErr) {
      logger.debug('[NLPWA] updateUI error on fail:', uiErr?.message || uiErr);
    }
  }

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
    event.waitUntil(handleBackgroundFetchFail(event, options));
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
