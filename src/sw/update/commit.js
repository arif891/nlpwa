import { getConfig, loadConfigFromCache } from '../config/index.js';
import { evictFromRuntime } from '../cache/runtime.js';
import { evictByRoute } from '../cache/evict.js';
import {
  getActive, getActiveName, setActive, getStaged, clearStaged,
  cleanupCaches, tryAcquire, release, withLock,
} from '../cache/store.js';
import { getSnapshotPath } from './manifest.js';
import { setUpdateStatus } from './index.js';
import { MESSAGE_TYPES } from '../../shared/constants.js';

/**
 * Make the staged update the live one. The switch itself is ONE write
 * (setActive), so a crash leaves either the old or the new version, never a mix.
 *
 * Caller must hold the lock (see commitIfReady) unless it is the update check.
 *
 * @returns {Promise<boolean>} true if a staged update was committed
 */
export async function commitStaged(event) {
  const config = getConfig();
  const staged = await getStaged();
  if (!staged?.complete) return false;

  // Crash window guard: if worker crashed after setActive but before clearStaged,
  // the staged cache is already the active cache. Discard stale staged pointer.
  const previousActive = await getActive();
  if (previousActive?.cache === staged.cache) {
    await clearStaged();
    return false;
  }

  setUpdateStatus('applying');

  // A complete cache always contains its snapshot. If not, discard it.
  const cache = await caches.open(staged.cache);
  if (!(await cache.match(getSnapshotPath()))) {
    console.warn('[NLPWA] Staged cache is missing its snapshot, discarding.');
    await clearStaged();
    await caches.delete(staged.cache);
    setUpdateStatus('idle');
    return false;
  }

  await setActive({
    cache: staged.cache,
    version: staged.version,
    swVersion: staged.swVersion,
    ...(config.retainPreviousVersionCache && previousActive?.cache ? { previousCache: previousActive.cache } : {}),
  });
  await clearStaged();

  // Load the newly committed version's configuration immediately so navigation
  // requests resolve against the new version's routes and settings.
  await loadConfigFromCache();
  const currentConfig = getConfig();

  // If the new version opted out of previous cache retention, update pointer
  if (!currentConfig.retainPreviousVersionCache && previousActive?.cache) {
    await setActive({
      cache: staged.cache,
      version: staged.version,
      swVersion: staged.swVersion,
    });
  }

  // Defer heavy disk cleanup and window messaging to event.waitUntil so the navigation
  // response is never blocked, preserving instant first-paint performance.
  const cleanupPromise = (async () => {
    try {
      const shouldClearRuntime = Boolean(
        staged.clearRuntime ||
        config.clearRuntimeOnUpdate ||
        currentConfig.clearRuntimeOnUpdate
      );

      if (shouldClearRuntime) {
        await caches.delete(currentConfig.caches.runtime);
      } else {
        await evictFromRuntime(staged.evict ?? []);
      }
      await evictByRoute();

      const keep = [staged.cache];
      if (currentConfig.retainPreviousVersionCache && previousActive?.cache) {
        keep.push(previousActive.cache);
      }
      await cleanupCaches({
        base: currentConfig.caches.offline,
        runtime: currentConfig.caches.runtime,
        keep,
      });

      if (previousActive && typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
        self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
          clients.forEach((c) => c.postMessage({ type: MESSAGE_TYPES.UPDATE_APPLIED, version: staged.version }));
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[NLPWA] Post-commit cleanup failed:', err?.message || err);
    } finally {
      setUpdateStatus('idle');
    }
  })();

  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(cleanupPromise);
  } else {
    await cleanupPromise;
  }

  console.log(`[NLPWA] Switched to v${staged.version}`);
  return true;
}

/**
 * Commit only if no update is currently being staged. Never waits: a page
 * navigation must not be held up by a download, it just tries again next time.
 *
 * @param {ExtendableEvent} [event]
 */
export async function commitIfReady(event) {
  return withLock(() => commitStaged(event), false);
}

/** Delete offline caches left behind by interrupted or superseded updates. */
export async function sweepOrphanCaches() {
  const config = getConfig();
  const [staged, active] = await Promise.all([getStaged(), getActive()]);
  await cleanupCaches({
    base: config.caches.offline,
    runtime: config.caches.runtime,
    keep: [await getActiveName(config.caches.offline), staged?.cache, active?.previousCache],
  });
}

