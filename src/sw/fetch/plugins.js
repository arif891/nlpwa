import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Collect all active plugins for a given route/options context.
 * Merges global config.plugins with route-level plugins and individual route hook functions.
 *
 * @param {Object} [options]
 * @returns {Array<Object>}
 */
export function getPlugins(options = {}) {
  const globalPlugins = Array.isArray(getConfig()?.plugins) ? getConfig().plugins : [];
  const routePlugins = Array.isArray(options?.plugins) ? options.plugins : [];

  const directHookPlugin = {};
  if (typeof options?.requestWillFetch === 'function') directHookPlugin.requestWillFetch = options.requestWillFetch;
  if (typeof options?.cachedResponseWillBeUsed === 'function') directHookPlugin.cachedResponseWillBeUsed = options.cachedResponseWillBeUsed;
  if (typeof options?.cacheWillUpdate === 'function') directHookPlugin.cacheWillUpdate = options.cacheWillUpdate;
  if (typeof options?.fetchDidSucceed === 'function') directHookPlugin.fetchDidSucceed = options.fetchDidSucceed;
  if (typeof options?.fetchDidFail === 'function') directHookPlugin.fetchDidFail = options.fetchDidFail;
  if (typeof options?.cacheDidUpdate === 'function') directHookPlugin.cacheDidUpdate = options.cacheDidUpdate;

  const plugins = [...globalPlugins, ...routePlugins];
  if (Object.keys(directHookPlugin).length > 0) {
    plugins.push(directHookPlugin);
  }
  return plugins;
}

/**
 * Execute requestWillFetch hook chain.
 * Allows plugins to modify the outgoing network Request or inspect headers/URL.
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {Request} params.request
 * @param {FetchEvent} [params.event]
 * @param {Object} [params.options]
 * @returns {Promise<Request>}
 */
export async function runRequestWillFetch(plugins, params) {
  let req = params.request;
  for (const plugin of plugins) {
    if (typeof plugin?.requestWillFetch === 'function') {
      const result = await plugin.requestWillFetch({ ...params, request: req });
      if (result instanceof Request) {
        req = result;
      }
    }
  }
  return req;
}

/**
 * Execute cachedResponseWillBeUsed hook chain.
 * Allows plugins to inspect or modify a cached response before it is used.
 * Returning explicit `null` from any plugin marks the cached entry as unusable (cache miss).
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {string} params.cacheName
 * @param {Request} params.request
 * @param {Object} [params.matchOptions]
 * @param {Response} params.cachedResponse
 * @param {FetchEvent} [params.event]
 * @param {Object} [params.options]
 * @returns {Promise<Response|null>}
 */
export async function runCachedResponseWillBeUsed(plugins, params) {
  let cached = params.cachedResponse;
  for (const plugin of plugins) {
    if (typeof plugin?.cachedResponseWillBeUsed === 'function') {
      const result = await plugin.cachedResponseWillBeUsed({ ...params, cachedResponse: cached });
      if (result === null) {
        return null;
      }
      if (result instanceof Response) {
        cached = result;
      }
    }
  }
  return cached;
}

/**
 * Execute cacheWillUpdate hook chain.
 * Called before saving a response to CacheStorage.
 * Returning explicit `null` or `false` prevents the response from being cached.
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {Request} params.request
 * @param {Response} params.response
 * @param {FetchEvent} [params.event]
 * @param {string} [params.cacheName]
 * @param {Object} [params.options]
 * @returns {Promise<Response|null>}
 */
export async function runCacheWillUpdate(plugins, params) {
  let resToCache = params.response;
  for (const plugin of plugins) {
    if (typeof plugin?.cacheWillUpdate === 'function') {
      const result = await plugin.cacheWillUpdate({ ...params, response: resToCache });
      if (result === null || result === false) {
        return null;
      }
      if (result instanceof Response) {
        resToCache = result;
      }
    }
  }
  return resToCache;
}

/**
 * Execute fetchDidSucceed hook chain.
 * Called after network fetch completes successfully.
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {Request} params.request
 * @param {Response} params.response
 * @param {FetchEvent} [params.event]
 * @param {Object} [params.options]
 * @returns {Promise<Response>}
 */
export async function runFetchDidSucceed(plugins, params) {
  let resp = params.response;
  for (const plugin of plugins) {
    if (typeof plugin?.fetchDidSucceed === 'function') {
      const result = await plugin.fetchDidSucceed({ ...params, response: resp });
      if (result instanceof Response) {
        resp = result;
      }
    }
  }
  return resp;
}

/**
 * Execute fetchDidFail hook chain.
 * Called when network fetch fails or throws.
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {Error} params.error
 * @param {Request} params.originalRequest
 * @param {Request} params.request
 * @param {FetchEvent} [params.event]
 * @param {Object} [params.options]
 * @returns {Promise<void>}
 */
export async function runFetchDidFail(plugins, params) {
  for (const plugin of plugins) {
    if (typeof plugin?.fetchDidFail === 'function') {
      try {
        await plugin.fetchDidFail(params);
      } catch (err) {
        logger.warn('[NLPWA] fetchDidFail plugin error:', err?.message || err);
      }
    }
  }
}

/**
 * Execute cacheDidUpdate hook chain.
 * Called after a response has been committed to cache.
 *
 * @param {Array<Object>} plugins
 * @param {Object} params
 * @param {string} params.cacheName
 * @param {Request} params.request
 * @param {Response} [params.oldResponse]
 * @param {Response} params.newResponse
 * @param {FetchEvent} [params.event]
 * @param {Object} [params.options]
 * @returns {Promise<void>}
 */
export async function runCacheDidUpdate(plugins, params) {
  for (const plugin of plugins) {
    if (typeof plugin?.cacheDidUpdate === 'function') {
      try {
        await plugin.cacheDidUpdate(params);
      } catch (err) {
        logger.warn('[NLPWA] cacheDidUpdate plugin error:', err?.message || err);
      }
    }
  }
}
