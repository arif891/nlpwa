import { getConfig, getUpdateEndpoints } from '../config/index.js';
import { openActive } from '../cache/store.js';

/**
 * Fetch lightweight app version from the server (Tier 1 check).
 *
 * @returns {Promise<{ version: string }>}
 */
export async function fetchServerVersion() {
  const { versionEndpoint } = getUpdateEndpoints();

  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(15000)
    : undefined;

  const response = await fetch(versionEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
    signal,
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

  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(30000)
    : undefined;

  const response = await fetch(infoEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
    signal,
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

/** Path of the snapshot entry inside an offline cache. */
export function getSnapshotPath() {
  return getConfig().snapshotCachePath;
}

let _activeSnapshotPaths = null;

export function getActiveSnapshotPaths() {
  return _activeSnapshotPaths;
}

export function setActiveSnapshotPaths(paths) {
  _activeSnapshotPaths = paths ? (paths instanceof Set ? paths : new Set(paths)) : null;
}

/**
 * Load the snapshot (hash map of what is currently live) from the ACTIVE
 * offline cache. Returns null on a fresh install.
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }|null>}
 */
export async function loadCachedSnapshot() {
  const cache = await openActive(getConfig().caches.offline);
  const response = await cache.match(getSnapshotPath());
  if (!response) {
    _activeSnapshotPaths = null;
    return null;
  }
  const data = await response.json();
  if (Array.isArray(data?.files)) {
    _activeSnapshotPaths = new Set(data.files.map((f) => f.path));
  }
  return data;
}

/**
 * Write a snapshot into a given offline cache. For a staged update this is the
 * LAST write: a cache that contains its snapshot is a complete one.
 *
 * @param {Cache} cache
 * @param {Object} snapshotData
 */
export async function writeSnapshot(cache, snapshotData) {
  const snapshot = { swVersion: getConfig().version, ...snapshotData };
  await cache.put(getSnapshotPath(), new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

/** Write a snapshot into the active offline cache (kept for compatibility). */
export async function saveCachedSnapshot(snapshotData) {
  const cache = await openActive(getConfig().caches.offline);
  await writeSnapshot(cache, snapshotData);
  if (Array.isArray(snapshotData?.files)) {
    _activeSnapshotPaths = new Set(snapshotData.files.map((f) => f.path));
  }
}
