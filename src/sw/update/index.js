import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { getStaged, clearStaged, withLock, setMinVersion, unpinClientsBelowVersion } from '../cache/store.js';
import { fetchServerVersion, fetchServerInfo, loadCachedSnapshot } from './manifest.js';
import { stageUpdate } from './stage.js';
import { commitStaged } from './commit.js';
import { setUpdateStatus, getUpdateStatus, getCurrentStatus } from './status.js';
import { MESSAGE_TYPES } from '../../shared/constants.js';
import { compare } from '../../shared/version.js';

export { setUpdateStatus, getUpdateStatus };

/**
 * Notify all connected clients with a postMessage.
 *
 * @param {Object} message
 */
async function broadcast(message) {
  if (typeof self === 'undefined' || !self.clients || typeof self.clients.matchAll !== 'function') return;
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(client => client.postMessage(message));
}

/**
 * Run a complete two-tier update check cycle:
 *
 *   1. Tier 1: lightweight version check (/api/update/version)
 *   2. Stop early if the live version already matches
 *   3. Tier 2: fetch the full file manifest (/api/update/info)
 *   4. Stage: build the new version in a separate cache (copy unchanged files,
 *      fetch + hash-verify the rest). The running app is not touched.
 *   5. Tell clients UPDATE_READY. The switch happens on the next navigation
 *      (or APPLY_UPDATE), so one page load is never served from two versions.
 *
 * On a first install there is nothing to protect, so the staged cache is
 * switched in right away and no banner is shown.
 *
 * Safe to call concurrently: a shared lock lets only one run proceed.
 *
 * @returns {Promise<{ updated: boolean, version?: string }>}
 */
export async function checkForUpdate(options = {}) {
  return await runUpdateCheck(options);
}

async function runUpdateCheck({ force = false } = {}) {
  setUpdateStatus('checking');
  try {
    return await _doUpdateCheck({ force });
  } finally {
    if (getCurrentStatus() === 'checking') {
      setUpdateStatus('idle');
    }
  }
}

async function _doUpdateCheck({ force = false } = {}) {
  const config = getConfig();

  const active = await loadCachedSnapshot();
  const staged = await getStaged();

  // ── Tier 1: lightweight version check ────────────────────────────────────
  let serverVersion;
  let versionRes;
  try {
    versionRes = await fetchServerVersion();
    if (versionRes?.notModified) {
      serverVersion = versionRes.version ?? active?.version;
    } else {
      serverVersion = versionRes?.version;
    }
  } catch (err) {
    logger.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest:', err.message);
  }

  // Check minimum supported version from Tier 1 if present
  const tier1Min = versionRes?.minVersion || versionRes?.minSupportedVersion;
  if (tier1Min) {
    await setMinVersion(tier1Min);
    const unpinned = await unpinClientsBelowVersion(tier1Min);
    const activeBelow = Boolean(active?.version && compare(active.version, tier1Min) < 0);
    if (activeBelow || unpinned.length > 0) {
      logger.warn(`[NLPWA] Active or pinned version is below minimum supported version (${tier1Min}). Update required.`);
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_REQUIRED,
        minVersion: tier1Min,
        activeVersion: active?.version || null,
        targetVersion: serverVersion || null,
        unpinnedClients: unpinned,
      });
    }
  }

  // A complete update is already staged and waiting for the next navigation.
  if (staged?.complete && staged.swVersion === config.version
      && (!serverVersion || serverVersion === staged.version)) {
    await broadcast({ type: MESSAGE_TYPES.UPDATE_READY, version: staged.version, staged: true });
    return { updated: true, version: staged.version, staged: true };
  }

  // If a previous retry failed and backoff has not expired yet, skip this periodic check unless forced
  if (!force && staged && !staged.complete && staged.nextRetryAt && Date.now() < staged.nextRetryAt) {
    logger.log(`[NLPWA] Staging retry in backoff until ${new Date(staged.nextRetryAt).toISOString()}`);
    return { updated: false, backingOff: true };
  }

  const isFresh = !active;
  const swVersionChanged = Boolean(active?.swVersion && active.swVersion !== config.version);
  const isCurrent = (version) => !isFresh && !swVersionChanged && version === active.version;

  const discardStaged = async () => {
    if (staged) {
      await withLock(async () => {
        logger.log(`[NLPWA] Server rolled back to v${active.version}; clearing staged update v${staged.version}`);
        await clearStaged();
        if (staged.cache) {
          await caches.delete(staged.cache).catch(() => {});
        }
      });
    }
  };

  if (serverVersion && isCurrent(serverVersion)) {
    await discardStaged();
    setUpdateStatus('idle');
    logger.log(`[NLPWA] App already up to date (v${active.version})`);
    await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
    return { updated: false, rolledBack: Boolean(staged) };
  }

  // ── Tier 2: full manifest ────────────────────────────────────────────────
  let serverManifest;
  try {
    serverManifest = await fetchServerInfo();
  } catch (err) {
    logger.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
    return { updated: false };
  }

  // Check minimum supported version from Tier 2 manifest
  const tier2Min = serverManifest?.minVersion || serverManifest?.minSupportedVersion || tier1Min;
  if (tier2Min) {
    await setMinVersion(tier2Min);
    const unpinned = await unpinClientsBelowVersion(tier2Min);
    const activeBelow = Boolean(active?.version && compare(active.version, tier2Min) < 0);
    if ((activeBelow || unpinned.length > 0) && !tier1Min) {
      logger.warn(`[NLPWA] Active or pinned version is below minimum supported version (${tier2Min}). Update required.`);
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_REQUIRED,
        minVersion: tier2Min,
        activeVersion: active?.version || null,
        targetVersion: serverManifest.version,
        unpinnedClients: unpinned,
      });
    }
  }

  if (isCurrent(serverManifest.version)) {
    await discardStaged();
    setUpdateStatus('idle');
    logger.log(`[NLPWA] App already up to date (v${active.version})`);
    await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
    return { updated: false, rolledBack: Boolean(staged) };
  }

  logger.log(isFresh
    ? `[NLPWA] Initial installation: staging v${serverManifest.version}`
    : `[NLPWA] Update available: v${active.version} → v${serverManifest.version}`);

  // ── Stage (active version keeps serving) ─────────────────────────────────
  // Narrow lock: acquire only around staging cache writes and commit
  setUpdateStatus('staging');
  return withLock(async () => {
    const currentActive = await loadCachedSnapshot();
    const result = await stageUpdate(serverManifest, { activeSnapshot: currentActive, forceRefetch: swVersionChanged });

    if (result.status === 'incomplete') {
      setUpdateStatus('idle');
      const errorCode = result.hasHashMismatch
        ? 'HASH_MISMATCH'
        : result.quotaExceeded
          ? 'QUOTA_EXCEEDED'
          : 'DOWNLOAD_FAILED';

      const errorMsg = result.hasHashMismatch
        ? `Hash mismatch verification failed for ${result.failed.join(', ')}`
        : result.quotaExceeded
          ? `Storage quota exceeded while staging ${result.failed.join(', ')}`
          : `Failed to download or verify ${result.failed.join(', ')}`;

      await broadcast({
        type: MESSAGE_TYPES.UPDATE_FAILED,
        errorCode,
        version: serverManifest.version,
        failed: result.failed,
        failedDetails: result.failedDetails,
        error: errorMsg,
        retryCount: result.retryCount,
        nextRetryAt: result.nextRetryAt,
        persistent: Boolean(result.persistent),
        hasHashMismatch: Boolean(result.hasHashMismatch),
        quotaExceeded: Boolean(result.quotaExceeded),
      });

      return { updated: false, errorCode, version: serverManifest.version, failed: result.failed, error: errorMsg, quotaExceeded: Boolean(result.quotaExceeded) };
    }

    if (isFresh) {
      setUpdateStatus('idle');
      await commitStaged();
      return { updated: false, version: serverManifest.version, initial: true };
    }

    setUpdateStatus('ready');
    await broadcast({
      type: MESSAGE_TYPES.UPDATE_READY,
      version: serverManifest.version,
      staged: true,
    });
    return { updated: true, version: serverManifest.version, staged: true };
  }, () => {
    logger.log('[NLPWA] Staging already in progress, skipping.');
    return { updated: false };
  });
}
