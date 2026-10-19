import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { getStaged, clearStaged, tryAcquire, release, withLock } from '../cache/store.js';
import { fetchServerVersion, fetchServerInfo, loadCachedSnapshot } from './manifest.js';
import { stageUpdate } from './stage.js';
import { commitStaged } from './commit.js';
import { MESSAGE_TYPES } from '../../shared/constants.js';

/**
 * Notify all connected clients with a postMessage.
 *
 * @param {Object} message
 */
async function broadcast(message) {
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

let _currentStatus = 'idle';

export function setUpdateStatus(status) {
  _currentStatus = status;
}

export async function getUpdateStatus() {
  const staged = await getStaged();
  if (staged?.complete) return 'ready';
  return _currentStatus;
}

async function runUpdateCheck({ force = false } = {}) {
  _currentStatus = 'checking';
  try {
    return await _doUpdateCheck({ force });
  } finally {
    if (_currentStatus === 'checking') {
      _currentStatus = 'idle';
    }
  }
}

async function _doUpdateCheck({ force = false } = {}) {
  const config = getConfig();

  // ── Tier 1: lightweight version check ────────────────────────────────────
  let serverVersion;
  try {
    serverVersion = (await fetchServerVersion()).version;
  } catch (err) {
    logger.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest:', err.message);
  }

  const active = await loadCachedSnapshot();
  const staged = await getStaged();

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
    _currentStatus = 'idle';
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

  if (isCurrent(serverManifest.version)) {
    await discardStaged();
    _currentStatus = 'idle';
    logger.log(`[NLPWA] App already up to date (v${active.version})`);
    await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
    return { updated: false, rolledBack: Boolean(staged) };
  }

  logger.log(isFresh
    ? `[NLPWA] Initial installation: staging v${serverManifest.version}`
    : `[NLPWA] Update available: v${active.version} → v${serverManifest.version}`);

  // ── Stage (active version keeps serving) ─────────────────────────────────
  // Narrow lock: acquire only around staging cache writes and commit
  _currentStatus = 'staging';
  return withLock(async () => {
    const result = await stageUpdate(serverManifest, { activeSnapshot: active, forceRefetch: swVersionChanged });

    if (result.status === 'incomplete') {
      _currentStatus = 'idle';
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
      _currentStatus = 'idle';
      await commitStaged();
      return { updated: false, version: serverManifest.version, initial: true };
    }

    _currentStatus = 'ready';
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
