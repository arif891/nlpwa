import { getConfig, getUpdateEndpoints } from '../config/index.js';

/**
 * Fetch lightweight app version from the server (Tier 1 check).
 *
 * @returns {Promise<{ version: string }>}
 */
export async function fetchServerVersion() {
  const { versionEndpoint } = getUpdateEndpoints();

  const response = await fetch(versionEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`[NLPWA] Version check failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (typeof data.version !== 'string' || !data.version) {
    throw new Error('[NLPWA] Version check response missing valid "version"');
  }

  return data;
}

/**
 * Fetch the latest file tree update info from the server (Tier 2 fetch).
 * Always bypasses browser cache (cache: 'no-store') to get the true current state.
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }>}
 */
export async function fetchServerInfo() {
  const { infoEndpoint } = getUpdateEndpoints();

  const response = await fetch(infoEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`[NLPWA] Update info fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`[NLPWA] Update info response is not valid JSON (is the endpoint returning HTML?): ${err.message}`);
  }

  // Validate the expected shape before passing to computeDiff / applyDiff
  if (typeof data.version !== 'string' || !data.version) {
    throw new Error('[NLPWA] Update info missing or invalid "version" field (expected a non-empty string)');
  }
  if (!Array.isArray(data.files)) {
    throw new Error('[NLPWA] Update info missing "files" array');
  }

  return data;
}

export const fetchServerManifest = fetchServerInfo;

/**
 * Load the cached update snapshot from the offline cache.
 * This is written after each successful update and contains the file-hash
 * map that was last successfully applied to the cache.
 *
 * Returns null on a fresh install (no snapshot yet stored).
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }|null>}
 */
export async function loadCachedSnapshot() {
  const config = getConfig();
  const cacheNames = config.caches;
  const snapshotPath = config.snapshotCachePath || config.manifestCachePath || '/_nlpwa/snapshot.json';

  const cache = await caches.open(cacheNames.offline);
  const response = await cache.match(snapshotPath);
  if (!response) return null;
  return response.json();
}

export const loadCachedManifest = loadCachedSnapshot;

/**
 * Persist the update info as a snapshot in the offline cache.
 * Called after all update operations succeed so it becomes the reference
 * for the next update check.
 *
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} snapshotData
 */
export async function saveCachedSnapshot(snapshotData) {
  const config = getConfig();
  const cacheNames = config.caches;
  const swVersion = config.version;
  const snapshotPath = config.snapshotCachePath || config.manifestCachePath || '/_nlpwa/snapshot.json';

  const cache = await caches.open(cacheNames.offline);

  const snapshot = {
    ...snapshotData,
    swVersion,
  };

  const response = new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await cache.put(snapshotPath, response);
}

export const saveCachedManifest = saveCachedSnapshot;
