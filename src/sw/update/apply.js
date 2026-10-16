import { getConfig, loadConfigFromCache } from '../config/index.js';
import { putInOffline, deleteFromOffline, evictFromRuntime, evictByRoute } from '../cache/index.js';
import { loadCachedSnapshot, saveCachedSnapshot } from './manifest.js';
import { MAX_RETRY_ATTEMPTS } from '../../shared/constants.js';

/**
 * Apply a computed diff to the caches, then run eviction and save the snapshot.
 *
 * Strategy:
 *   - added/modified  → fetch fresh and store in offline cache
 *     (individual failures leave the old cached version in place)
 *   - removed         → delete from offline cache
 *   - runtime cache   → evict ONLY entries whose hash changed or that were removed
 *     (preserves lazily-cached images/data)
 *   - route eviction  → evict offline + runtime entries no longer matching
 *     a caching-capable route
 *   - snapshot        → write new snapshot with only successfully applied hashes;
 *     failed files keep old hashes and flag needsRetry for self-healing.
 *
 * @param {{ added: string[], modified: string[], removed: string[] }} diff
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} newManifest
 * @returns {Promise<{ success: boolean, failed: string[], applied: number, gaveUp: boolean }>}
 */
export async function applyDiff(diff, newManifest) {
  const previousSnapshot = await loadCachedSnapshot();
  const prevFileMap = new Map(previousSnapshot?.files?.map(f => [f.path, f.hash]) ?? []);

  // ── 1. Fetch and store added + modified files ───────────────────────────
  const toFetch = [...diff.added, ...diff.modified];
  const successfulFetches = new Set();
  const failedFetches = new Set();

  await Promise.all(
    toFetch.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) {
          await putInOffline(path, response);
          successfulFetches.add(path);
          console.log(`[NLPWA] Cached: ${path}`);
        } else {
          failedFetches.add(path);
          console.warn(`[NLPWA] Skip (HTTP ${response.status}): ${path}`);
        }
      } catch (err) {
        failedFetches.add(path);
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

  // ── 3. Evict ONLY stale/removed entries from runtime cache ──────────────
  // Only evict modified and removed files — lazily cached runtime entries
  // (images, articles, feeds) remain intact.
  const runtimeEvictions = [...diff.modified, ...diff.removed];
  await evictFromRuntime(runtimeEvictions);

  // If config file was updated and fetched, reload in-memory config so new routes apply immediately
  const configPath = getConfig().configPath || '/config.json';
  if (successfulFetches.has(configPath)) {
    await loadConfigFromCache();
    console.log('[NLPWA] Reloaded updated config into active router');
  }

  // ── 4. Route-aware eviction on both caches ──────────────────────────────
  await evictByRoute();

  // ── 5. Persist new snapshot (self-healing) ──────────────────────────────
  // Files that failed to fetch keep their old hash from previous snapshot
  // (or are omitted if newly added), so computeDiff will retry them next time.
  const snapshotFiles = [];
  for (const file of newManifest.files) {
    if (failedFetches.has(file.path)) {
      const oldHash = prevFileMap.get(file.path);
      if (oldHash) {
        snapshotFiles.push({ path: file.path, hash: oldHash });
      }
    } else {
      snapshotFiles.push(file);
    }
  }

  const hasFailures = failedFetches.size > 0;

  // Count consecutive failed attempts; after MAX_RETRY_ATTEMPTS stop retrying
  // on every check. Failed files keep their old hash (or are omitted), so the
  // next app version bump will pick them up again naturally.
  const attempts = hasFailures
    ? (previousSnapshot?.needsRetry ? (previousSnapshot.retryCount ?? 0) : 0) + 1
    : 0;
  const gaveUp = hasFailures && attempts >= MAX_RETRY_ATTEMPTS;
  const needsRetry = hasFailures && !gaveUp;

  await saveCachedSnapshot({
    ...newManifest,
    files: snapshotFiles,
    needsRetry,
    ...(needsRetry ? { retryCount: attempts } : {}),
  });

  if (gaveUp) {
    console.error(
      `[NLPWA] Giving up retrying ${failedFetches.size} file(s) after ${attempts} attempts: ` +
      Array.from(failedFetches).join(', ')
    );
  }

  console.log(
    `[NLPWA] Update applied → v${newManifest.version} ` +
    `(+${successfulFetches.size} updated, -${diff.removed.length} removed` +
    (hasFailures ? `, ${failedFetches.size} failed${needsRetry ? ' — will retry' : ''})` : ')')
  );

  return {
    success: !hasFailures,
    failed: Array.from(failedFetches),
    applied: successfulFetches.size + diff.removed.length,
    gaveUp,
  };
}
