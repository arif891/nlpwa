/**
 * Validate that a manifest path is safe from traversal, absolute URLs, or backslashes.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isSafePath(path) {
  if (typeof path !== 'string' || !path) return false;
  // Reject ASCII control characters and null bytes
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  // Reject absolute URLs with protocols (e.g. http:, https:, data:, javascript:)
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  // Reject backslashes anywhere in path (prevent Windows/URL parser normalization quirks)
  if (path.includes('\\')) return false;
  // Must start with a single forward slash and not be followed by / or \
  if (!/^\/(?![\/\\])/.test(path)) return false;

  // Decode URI components safely to catch percent-encoded traversal (e.g. /%2e%2e/)
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false; // Malformed percent-encoding is rejected
  }
  if (/[\x00-\x1f\x7f]/.test(decoded)) return false;
  if (decoded.includes('\\')) return false;
  // Reject path traversal with '..' segments (both literal and percent-encoded)
  if (/(?:^|\/)\.\.(?:\/|$)/.test(decoded) || /(?:^|\/)\.\.(?:\/|$)/.test(path)) return false;

  return true;
}

/**
 * Compute the delta between a new server manifest and the currently cached one.
 *
 * The delta drives the update: only files that actually changed are fetched.
 * Because the server always returns the full file list, this automatically
 * handles any size of version jump (v1 → v100) in one pass.
 *
 * @param {Array<{ path: string, hash: string }>} newFiles   from server manifest
 * @param {Array<{ path: string, hash: string }>|null} oldFiles  from cached manifest
 *                                                               (null = fresh install)
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
export function computeDiff(newFiles, oldFiles) {
  const safeNewFiles = (newFiles ?? []).filter(f => isSafePath(f?.path));
  const safeOldFiles = (oldFiles ?? []).filter(f => isSafePath(f?.path));

  // Build lookup maps for O(1) access
  const oldMap = new Map(safeOldFiles.map(f => [f.path, f.hash]));
  const newMap = new Map(safeNewFiles.map(f => [f.path, f.hash]));

  const added    = [];
  const modified = [];
  const removed  = [];

  // Files that are new or changed
  for (const [path, hash] of newMap) {
    if (!oldMap.has(path)) {
      added.push(path);
    } else if (oldMap.get(path) !== hash) {
      modified.push(path);
    }
    // hash unchanged → no action needed
  }

  // Files that exist in old manifest but are gone in new manifest
  for (const path of oldMap.keys()) {
    if (!newMap.has(path)) {
      removed.push(path);
    }
  }

  return { added, modified, removed };
}

/**
 * Diff used when the SW engine version changes: every file in the new manifest
 * is re-fetched (`added`), but files that existed in the previous snapshot and
 * are no longer in the manifest are still reported as `removed`, so orphans
 * don't linger in the offline cache.
 *
 * @param {Array<{ path: string, hash: string }>} newFiles
 * @param {Array<{ path: string, hash: string }>|null} oldFiles
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
export function computeRefreshDiff(newFiles, oldFiles) {
  const { added } = computeDiff(newFiles, null);
  const { removed } = computeDiff(newFiles, oldFiles ?? null);
  return { added, modified: [], removed };
}
