import { getConfig } from '../config/index.js';

/**
 * Fetch the latest file tree manifest from the server.
 * Always bypasses browser cache (cache: 'no-store') to get the true current state.
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }>}
 */
export async function fetchServerManifest() {
  const { manifestEndpoint } = getConfig();

  const response = await fetch(manifestEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`[NLPWA] Manifest fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Load the cached manifest snapshot from the offline cache.
 * This is written after each successful update and contains the file-hash
 * map that was last successfully applied to the cache.
 *
 * Returns null on a fresh install (no snapshot yet stored).
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }|null>}
 */
export async function loadCachedManifest() {
  const { caches: cacheNames, manifestCachePath } = getConfig();
  const cache = await caches.open(cacheNames.offline);
  const response = await cache.match(manifestCachePath);
  if (!response) return null;
  return response.json();
}

/**
 * Persist the server manifest as a snapshot in the offline cache.
 * Called after all update operations succeed so it becomes the reference
 * for the next update check.
 *
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} manifest
 */
export async function saveCachedManifest(manifest) {
  const { caches: cacheNames, manifestCachePath } = getConfig();
  const cache = await caches.open(cacheNames.offline);

  const response = new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await cache.put(manifestCachePath, response);
}
