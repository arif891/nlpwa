import { getConfig, loadConfigFromCache } from '../config/index.js';
import { evictFromRuntime } from '../cache/runtime.js';
import { evictByRoute } from '../cache/evict.js';
import {
  getActiveName, setActive, getStaged, clearStaged,
  cleanupCaches, tryAcquire, release,
} from '../cache/store.js';
import { getSnapshotPath } from './manifest.js';

/**
 * Make the staged update the live one. The switch itself is ONE write
 * (setActive), so a crash leaves either the old or the new version, never a mix.
 *
 * Caller must hold the lock (see commitIfReady) unless it is the update check.
 *
 * @returns {Promise<boolean>} true if a staged update was committed
 */
export async function commitStaged() {
  const config = getConfig();
  const staged = await getStaged();
  if (!staged?.complete) return false;

  // A complete cache always contains its snapshot. If not, discard it.
  const cache = await caches.open(staged.cache);
  if (!(await cache.match(getSnapshotPath()))) {
    console.warn('[NLPWA] Staged cache is missing its snapshot, discarding.');
    await clearStaged();
    await caches.delete(staged.cache);
    return false;
  }

  await setActive({ cache: staged.cache, version: staged.version, swVersion: staged.swVersion });
  await clearStaged();

  // Everything below is cleanup after the switch; the new version is already live.
  await loadConfigFromCache();
  if (staged.clearRuntime) {
    await caches.delete(config.caches.runtime);
  } else {
    await evictFromRuntime(staged.evict ?? []);
  }
  await evictByRoute();
  await cleanupCaches({ base: config.caches.offline, runtime: config.caches.runtime, keep: [staged.cache] });

  console.log(`[NLPWA] Switched to v${staged.version}`);
  return true;
}

/**
 * Commit only if no update is currently being staged. Never waits: a page
 * navigation must not be held up by a download, it just tries again next time.
 */
export async function commitIfReady() {
  if (!tryAcquire()) return false;
  try {
    return await commitStaged();
  } finally {
    release();
  }
}

/** Delete offline caches left behind by interrupted or superseded updates. */
export async function sweepOrphanCaches() {
  const config = getConfig();
  const staged = await getStaged();
  await cleanupCaches({
    base: config.caches.offline,
    runtime: config.caches.runtime,
    keep: [await getActiveName(config.caches.offline), staged?.cache],
  });
}
