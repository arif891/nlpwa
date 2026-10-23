import { getConfig } from '../../config/index.js';
import { openActive, getActive, getClientPinnedCache } from '../meta/index.js';
import { matchWithAliases } from './aliases.js';

/**
 * Read a response from the offline (app shell) cache.
 *
 * @param {Request|string} request
 * @param {CacheQueryOptions} [matchOptions]
 * @param {string|null} [clientId]
 * @returns {Promise<Response|undefined>}
 */
async function cacheExists(name) {
  if (typeof caches === 'undefined' || !name) return false;
  if (typeof caches.has === 'function') {
    return caches.has(name);
  }
  if (typeof caches.keys === 'function') {
    const keys = await caches.keys();
    return keys.includes(name);
  }
  return true;
}

export async function getFromOffline(request, matchOptions, clientId = null) {
  const config = getConfig();
  const { caches: cacheNames, retainPreviousVersionCache, base } = config;

  let cache;
  const pinnedName = clientId ? getClientPinnedCache(clientId) : null;
  if (pinnedName && (await cacheExists(pinnedName))) {
    cache = await caches.open(pinnedName);
  } else {
    cache = await openActive(cacheNames.offline);
  }

  let hit = await matchWithAliases(cache, request, matchOptions, base, config);

  if (!hit && retainPreviousVersionCache) {
    const active = await getActive();
    if (active?.previousCache && active.previousCache !== pinnedName && (await cacheExists(active.previousCache))) {
      try {
        const prev = await caches.open(active.previousCache);
        hit = await matchWithAliases(prev, request, matchOptions, base, config);
      } catch {
        // previous cache may have been removed
      }
    }
  }

  return hit;
}

/**
 * Write a response into the offline cache.
 * Used by the update system to store fresh file fetches.
 *
 * @param {Request|string} request
 * @param {Response} response
 */
export async function putInOffline(request, response) {
  const { caches: cacheNames } = getConfig();
  const cache = await openActive(cacheNames.offline);
  await cache.put(request, response.clone());
}

/**
 * Delete a URL from the offline cache.
 *
 * @param {Request|string} request
 */
export async function deleteFromOffline(request) {
  const { caches: cacheNames } = getConfig();
  const cache = await openActive(cacheNames.offline);
  await cache.delete(request);
}
