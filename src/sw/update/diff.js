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
function isSafePath(path) {
  if (typeof path !== 'string' || !path) return false;
  // Reject absolute URLs with protocols (e.g. http:, https:, data:) and protocol-relative URLs (//)
  if (path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
}

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
