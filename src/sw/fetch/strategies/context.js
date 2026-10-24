import {
  getFromOffline,
  getFromRuntime,
  putInRuntime,
} from '../../cache/runtime.js';
import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { createRangeResponse } from '../range.js';
import { isResponseExpired } from '../../../shared/time.js';
import {
  getPlugins,
  runRequestWillFetch,
  runCachedResponseWillBeUsed,
  runCacheWillUpdate,
  runFetchDidSucceed,
  runFetchDidFail,
  runCacheDidUpdate,
  runCacheKeyWillBeUsed,
} from '../plugins.js';

/**
 * Helper to tag a cached response and handle Range requests if requested.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {string} tag
 * @returns {Promise<Response>}
 */
export async function serveCached(request, response, tag) {
  const tagged = tagResponse(response, tag);
  if (request?.headers && typeof request.headers.has === 'function' && request.headers.has('range')) {
    return createRangeResponse(request, tagged);
  }
  return tagged;
}

/**
 * Execute a network fetch through requestWillFetch, fetchDidSucceed, and fetchDidFail plugin hooks.
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @param {Array<Object>} [plugins]
 * @returns {Promise<Response>}
 */
export async function performFetch(request, event, options = {}, plugins = getPlugins(options)) {
  const finalRequest = await runRequestWillFetch(plugins, { request, event, options });
  if (finalRequest instanceof Response) {
    return finalRequest;
  }
  try {
    const rawResponse = await fetch(finalRequest);
    const finalResponse = await runFetchDidSucceed(plugins, {
      request: finalRequest,
      response: rawResponse,
      event,
      options,
    });
    return finalResponse;
  } catch (err) {
    await runFetchDidFail(plugins, {
      error: err,
      originalRequest: request,
      request: finalRequest,
      event,
      options,
    });
    throw err;
  }
}

/**
 * Safely put a response clone into the runtime cache without blocking the main response.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 */
export function safePutInRuntime(request, response, event, options = {}) {
  if (!response || response.status === 206) return Promise.resolve();
  if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) return Promise.resolve();

  if (response.type === 'opaque') {
    const allowOpaque = Boolean(
      options?.cacheOpaque ??
      getConfig().cacheOpaque ??
      false
    );
    if (!allowOpaque) {
      return Promise.resolve();
    }
  } else if (!response.ok) {
    return Promise.resolve();
  }

  let toCache;
  try {
    toCache = response.clone();
  } catch (err) {
    logger.warn('[NLPWA] Could not clone response for runtime cache:', err?.message || err);
    return Promise.resolve();
  }

  const asyncWrite = (async () => {
    const plugins = getPlugins(options);
    const cacheName = getConfig().caches?.runtime || 'runtime';

    let cacheKey = request;
    try {
      cacheKey = await runCacheKeyWillBeUsed(plugins, {
        request,
        mode: 'write',
        event,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
    }

    let responseToCache;
    try {
      responseToCache = await runCacheWillUpdate(plugins, {
        request: cacheKey,
        response: toCache,
        event,
        cacheName,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] cacheWillUpdate error:', err?.message || err);
      return;
    }

    if (!responseToCache) return;

    if (responseToCache.type === 'opaque') {
      const allowOpaque = Boolean(
        options?.cacheOpaque ??
        getConfig().cacheOpaque ??
        false
      );
      if (!allowOpaque) return;
    } else if (!responseToCache.ok) {
      return;
    }

    try {
      await putInRuntime(cacheKey, responseToCache);
      await runCacheDidUpdate(plugins, {
        cacheName,
        request: cacheKey,
        newResponse: responseToCache,
        event,
        options,
      });
    } catch (err) {
      logger.warn('[NLPWA] Runtime cache write failed:', err?.message || err);
    }
  })();

  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(asyncWrite);
  }
  return asyncWrite;
}

/**
 * Determine whether a strategy failure should rethrow/reject instead of returning a 503 response.
 *
 * @param {Object} [options]
 * @returns {boolean}
 */
export function getShouldThrow(options) {
  return Boolean(
    options?.throwOnFailure ??
    getConfig().throwOnFailure ??
    false
  );
}

/**
 * Resolve offline navigation fallback URL from route options or global config.
 *
 * @param {Object} [options]
 * @returns {string}
 */
export function resolveFallbackUrl(options = {}) {
  return options.offlineFallback ?? getConfig().offlineFallback ?? '/index.html';
}

/**
 * Look in offline then runtime cache; returns a tagged Response, expired descriptor, or null.
 *
 * @param {Object} params
 * @returns {Promise<Response|{ expired: true, response: Response }|null>}
 */
export async function lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event, maxAgeMs }) {
  let cacheKey = request;
  try {
    cacheKey = await runCacheKeyWillBeUsed(plugins, { request, mode: 'read', event, options });
  } catch (err) {
    logger.warn('[NLPWA] cacheKeyWillBeUsed error:', err?.message || err);
  }

  const offlineName = getConfig().caches?.offline || 'offline';
  const runtimeName = getConfig().caches?.runtime || 'runtime';

  let offlineCached = await getFromOffline(cacheKey, matchOptions, clientId);
  if (offlineCached) {
    offlineCached = await runCachedResponseWillBeUsed(plugins, {
      cacheName: offlineName,
      request: cacheKey,
      matchOptions,
      cachedResponse: offlineCached,
      event,
      options,
    });
    if (offlineCached) return serveCached(request, offlineCached, CACHE_STATUS.OFFLINE_CACHE);
  }

  let runtimeCached = await getFromRuntime(cacheKey, matchOptions);
  if (runtimeCached) {
    runtimeCached = await runCachedResponseWillBeUsed(plugins, {
      cacheName: runtimeName,
      request: cacheKey,
      matchOptions,
      cachedResponse: runtimeCached,
      event,
      options,
    });
    if (runtimeCached) {
      if (maxAgeMs && isResponseExpired(runtimeCached, maxAgeMs)) {
        return { expired: true, response: runtimeCached };
      }
      return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
    }
  }

  return null;
}
