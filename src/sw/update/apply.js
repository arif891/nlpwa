import { getConfig, loadConfigFromCache } from '../config/index.js';
import { putInOffline, deleteFromOffline, evictFromRuntime, evictByRoute } from '../cache/index.js';
import { saveCachedSnapshot } from './manifest.js';

/**
 * Apply a computed diff to the caches, then run eviction and save the snapshot.
 *
 * Strategy:
 *   - added/modified  → fetch fresh and store in offline cache
 *     (individual failures are skipped with a warning; stale version stays)
 *   - removed         → delete from offline cache
 *   - runtime cache   → evict entries whose hash changed or that were removed
 *     (they will be re-fetched fresh on the next browser request)
 *   - route eviction  → evict offline + runtime entries no longer matching
 *     a caching-capable route
 *   - snapshot        → write new snapshot as /_nlpwa/snapshot.json
 *
 * There is intentionally no rollback. Failed fetches leave the old cached
 * file in place. The update system is self-healing: on the next check, the
 * diff will catch any still-stale files and retry.
 *
 * @param {{ added: string[], modified: string[], removed: string[] }} diff
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} newManifest
 */
export async function applyDiff(diff, newManifest) {
  const { caches: cacheNames } = getConfig();

  // ── 1. Fetch and store added + modified files ───────────────────────────
  const toFetch = [...diff.added, ...diff.modified];

  await Promise.all(
    toFetch.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) {
          await putInOffline(path, response);
          console.log(`[NLPWA] Cached: ${path}`);
        } else {
          console.warn(`[NLPWA] Skip (HTTP ${response.status}): ${path}`);
        }
      } catch (err) {
        console.warn(`[NLPWA] Skip (network error): ${path}`, err.message);
      }
    })
  );

  // ── 2. Delete removed files from offline cache ──────────────────────────
  await Promise.all(
    diff.removed.map(async (path) => {
      await deleteFromOffline(path);
      console.log(`[NLPWA] Deleted: ${path}`);
    })
  );

  // ── 3. Evict stale/removed entries from runtime cache ───────────────────
  //    Modified files: evict so fresh version is fetched on next request.
  //    Removed files:  evict so deleted resource stops being served.
  const runtimeEvictions = [...diff.modified, ...diff.removed];
  await evictFromRuntime(runtimeEvictions);

  // Also evict runtime entries not present in the new manifest at all.
  // Use the original Request objects (not extracted pathnames) so cache.delete()
  // matches by the full URL — pathname-only strings would fail for cross-origin entries.
  const newPaths = new Set(newManifest.files.map(f => f.path));
  const runtimeCache = await caches.open(cacheNames.runtime);
  const runtimeKeys  = await runtimeCache.keys();
  const unknownRequests = runtimeKeys.filter(r => !newPaths.has(new URL(r.url).pathname));
  await Promise.all(unknownRequests.map(r => runtimeCache.delete(r)));

  // If config file was updated, reload in-memory config so new routes apply immediately
  const configPath = getConfig().configPath || '/config.json';
  if (toFetch.includes(configPath)) {
    await loadConfigFromCache();
    console.log('[NLPWA] Reloaded updated config into active router');
  }

  // ── 4. Route-aware eviction on both caches ──────────────────────────────
  await evictByRoute();

  // ── 5. Persist new snapshot ─────────────────────────────────────────────
  await saveCachedSnapshot(newManifest);

  console.log(
    `[NLPWA] Update complete → v${newManifest.version} ` +
    `(+${diff.added.length} added, ~${diff.modified.length} modified, ` +
    `-${diff.removed.length} removed)`
  );
}
