import { getConfig, loadConfigFromCache } from '../config/index.js';
import { logger } from '../logger.js';
import { evictFromRuntime } from '../cache/runtime.js';
import { evictByRoute } from '../cache/evict.js';
import {
  getActive, getActiveName, setActive, getStaged, clearStaged,
  cleanupCaches, getAllPinnedCaches, pruneClientPins, withLock,
  blockVersion, readMeta, writeMeta,
} from '../cache/store.js';
import { getSnapshotPath } from './manifest.js';
import { setUpdateStatus, setCommitDeferred } from './status.js';
import { MESSAGE_TYPES } from '../../shared/constants.js';
import { resolvePathWithBase } from '../../shared/url.js';
import { sendSWTelemetry } from '../telemetry.js';

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
    logger.warn('[NLPWA] Staged cache is missing its snapshot, discarding.');
    await clearStaged();
    await caches.delete(staged.cache);
    setUpdateStatus('idle');
    return false;
  }

  // Inspect incoming version's config from the staged cache before setActive
  // to determine retainPreviousVersionCache in a single atomic write.
  let retainPrevious = Boolean(config.retainPreviousVersionCache);
  try {
    const rawConfigPath = config.configPath || '/api/update/config.json';
    const configPath = resolvePathWithBase(rawConfigPath, config.base);
    const stagedConfigRes = (await cache.match(configPath)) || (configPath !== rawConfigPath ? await cache.match(rawConfigPath) : null);
    if (stagedConfigRes) {
      const stagedConfigJson = await stagedConfigRes.clone().json();
      if (typeof stagedConfigJson.retainPreviousVersionCache === 'boolean') {
        retainPrevious = stagedConfigJson.retainPreviousVersionCache;
      }
    }
  } catch (err) {
    logger.debug('[NLPWA] Failed to read retainPreviousVersionCache from staged config:', err?.message || err);
  }

  await setActive({
    cache: staged.cache,
    version: staged.version,
    swVersion: staged.swVersion,
    ...(previousActive?.cache ? {
      fallbackCache: previousActive.cache,
      fallbackVersion: previousActive.version,
    } : {}),
    ...(retainPrevious && previousActive?.cache ? { previousCache: previousActive.cache } : {}),
  });
  await clearStaged();

  const probationConfig = typeof config.probation === 'object' && config.probation !== null
    ? config.probation
    : (config.probation !== false ? { requiredHealthyBoots: 2, failureThreshold: 2, clientBlockTtlMs: 24 * 60 * 60 * 1000 } : null);

  if (probationConfig && previousActive?.cache) {
    await writeMeta('/_nlpwa/probation.json', {
      version: staged.version,
      status: 'probation',
      healthyBoots: 0,
      consecutiveFailures: 0,
      requiredHealthyBoots: probationConfig.requiredHealthyBoots ?? 2,
      failureThreshold: probationConfig.failureThreshold ?? 2,
      clientBlockTtlMs: probationConfig.clientBlockTtlMs ?? (24 * 60 * 60 * 1000),
      committedAt: Date.now(),
    });
  }

  // Load the newly committed version's configuration immediately so navigation
  // requests resolve against the new version's routes and settings.
  await loadConfigFromCache();
  const currentConfig = getConfig();

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
      if (previousActive?.cache) {
        keep.push(previousActive.cache);
      }
      const activeMeta = await getActive();
      if (activeMeta?.fallbackCache) {
        keep.push(activeMeta.fallbackCache);
      }
      await pruneClientPins();
      const pinned = getAllPinnedCaches();
      keep.push(...pinned);

      await cleanupCaches({
        base: currentConfig.caches.offline,
        runtime: currentConfig.caches.runtime,
        keep,
      });

      if (previousActive && typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
        self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
          clients.forEach((c) => c.postMessage({ type: MESSAGE_TYPES.UPDATE_APPLIED, version: staged.version }));
        }).catch((err) => {
          logger.debug('[NLPWA] Failed to broadcast UPDATE_APPLIED to clients:', err?.message || err);
        });
      }
    } catch (err) {
      logger.warn('[NLPWA] Post-commit cleanup failed:', err?.message || err);
    } finally {
      setUpdateStatus('idle');
    }
  })();

  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(cleanupPromise);
  } else {
    await cleanupPromise;
  }

  setCommitDeferred(false);
  logger.log(`[NLPWA] Switched to v${staged.version}`);
  return true;
}

/**
 * Emergency or watchdog rollback: Revert active version to the fallback cache,
 * block the failing version, and notify all open clients.
 *
 * @param {string} [reason] - Reason for rollback
 * @returns {Promise<{ success: boolean, version?: string, rolledBackFrom?: string, error?: string }>}
 */
export async function rollbackToFallback(reason = '', { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  return await withLock(async () => {
    const active = await getActive();
    if (!active?.fallbackCache || !active?.fallbackVersion) {
      logger.warn('[NLPWA] Rollback requested, but no fallback cache is available.');
      return { success: false, error: 'NO_FALLBACK_CACHE' };
    }

    const fallbackCacheName = active.fallbackCache;
    const fallbackVersion = active.fallbackVersion;
    const failingVersion = active.version;
    const failingCache = active.cache;

    // Verify fallback cache is intact
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      const names = await caches.keys();
      if (!names.includes(fallbackCacheName)) {
        logger.warn(`[NLPWA] Fallback cache "${fallbackCacheName}" was evicted; cannot roll back.`);
        return { success: false, error: 'FALLBACK_CACHE_EVICTED' };
      }
    }

    // 1. Blacklist the failing version with 24h TTL
    await blockVersion(failingVersion, reason || 'Emergency/watchdog rollback', { ttlMs });

    try {
      const historyEntry = {
        timestamp: Date.now(),
        fromVersion: failingVersion,
        toVersion: fallbackVersion,
        reason: reason || 'Emergency/watchdog rollback',
      };
      const existing = (await readMeta('/_nlpwa/rollback-history.json')) || [];
      existing.push(historyEntry);
      await writeMeta('/_nlpwa/rollback-history.json', existing.slice(-20));

      const probation = await readMeta('/_nlpwa/probation.json');
      if (probation) {
        probation.status = 'rolled_back';
        await writeMeta('/_nlpwa/probation.json', probation);
      }
      sendSWTelemetry('rollback', { fromVersion: failingVersion, toVersion: fallbackVersion, reason }).catch(() => {});
    } catch (e) {
      logger.debug('[NLPWA] Failed to record rollback history:', e);
    }

    // 2. Atomic switch active pointer back to fallback cache
    await setActive({
      cache: fallbackCacheName,
      version: fallbackVersion,
      swVersion: active.swVersion,
    });

    // 3. Reload config from restored cache
    await loadConfigFromCache();

    // 4. Delete the broken failing cache
    if (failingCache && failingCache !== fallbackCacheName) {
      await caches.delete(failingCache).catch((err) => {
        logger.debug('[NLPWA] Failed to delete broken cache after rollback:', err?.message || err);
      });
    }

    logger.warn(`[NLPWA] ROLLBACK EXECUTED: Reverted from v${failingVersion} to v${fallbackVersion}.${reason ? ` Reason: ${reason}` : ''}`);

    // 5. Broadcast ROLLBACK_APPLIED to all clients so they can reload or display a notice
    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        clients.forEach((c) => c.postMessage({
          type: MESSAGE_TYPES.ROLLBACK_APPLIED,
          version: fallbackVersion,
          rolledBackFrom: failingVersion,
          reason,
        }));
      }).catch((err) => {
        logger.debug('[NLPWA] Failed to broadcast ROLLBACK_APPLIED to clients:', err?.message || err);
      });
    }

    return {
      success: true,
      version: fallbackVersion,
      rolledBackFrom: failingVersion,
      reason,
    };
  }, { success: false, error: 'LOCK_UNAVAILABLE' }, { wait: true });
}

/**
 * Commit only if no update is currently being staged. Never waits: a page
 * navigation must not be held up by a download, it just tries again next time.
 *
 * @param {ExtendableEvent} [event]
 */
export async function commitIfReady(event) {
  const staged = await getStaged();
  if (!staged?.complete) return false;

  const committed = await withLock(() => commitStaged(event), false);
  if (!committed) {
    setCommitDeferred(true);
    logger.debug('[NLPWA] Commit deferred: operation lock busy.');
  } else {
    setCommitDeferred(false);
  }
  return committed;
}

/** Delete offline caches left behind by interrupted or superseded updates. */
export async function sweepOrphanCaches() {
  const config = getConfig();
  await pruneClientPins();
  const [staged, active] = await Promise.all([getStaged(), getActive()]);
  const pinned = getAllPinnedCaches();
  await cleanupCaches({
    base: config.caches.offline,
    runtime: config.caches.runtime,
    keep: [await getActiveName(config.caches.offline), staged?.cache, active?.previousCache, active?.fallbackCache, ...pinned],
  });
}

