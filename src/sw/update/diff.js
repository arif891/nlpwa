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
  // Build lookup maps for O(1) access
  const oldMap = new Map((oldFiles ?? []).map(f => [f.path, f.hash]));
  const newMap = new Map(newFiles.map(f => [f.path, f.hash]));

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
