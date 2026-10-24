import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import {
  getStaged, clearStaged, withLock, setMinVersion, unpinClientsBelowVersion,
  readMeta, writeMeta, isVersionBlocked, syncBlockedVersions,
} from '../cache/store.js';
import { fetchServerVersion, fetchServerInfo, loadCachedSnapshot } from './manifest.js';
import { stageUpdate } from './stage.js';
import { commitStaged, rollbackToFallback } from './commit.js';
import { setUpdateStatus, getUpdateStatus, getCurrentStatus, isCommitDeferred, setCommitDeferred } from './status.js';
import { MESSAGE_TYPES } from '../../shared/constants.js';
import { compare } from '../../shared/version.js';
import { verifyManifestSignature } from '../../shared/crypto.js';

export {
  setUpdateStatus, getUpdateStatus, getCurrentStatus, isCommitDeferred, setCommitDeferred,
  rollbackToFallback,
};

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
 * Enforce minimum supported version rules across Tier 1 (version.json) or Tier 2 (info.json).
 * Unpins tabs below minVersion and broadcasts UPDATE_REQUIRED if needed.
 *
 * @param {Object|string|null} source - Version response or manifest object
 * @param {Object} [options]
 * @param {Object|null} [options.active] - Currently active snapshot
 * @param {boolean} [options.alreadyEnforced] - Whether minVersion was already broadcasted in this check cycle
 * @param {string|null} [options.targetVersion] - Target app version to include in broadcast
 * @returns {Promise<boolean>} True if a minVersion was present and enforced
 */
async function enforceMinVersion(source, { active = null, alreadyEnforced = false, targetVersion = null } = {}) {
  const minVersion = source?.minVersion || source?.minSupportedVersion || (typeof source === 'string' ? source : null);
  if (!minVersion) return false;

  await setMinVersion(minVersion);
  const unpinned = await unpinClientsBelowVersion(minVersion);
  const activeBelow = Boolean(active?.version && compare(active.version, minVersion) < 0);

  if ((activeBelow || unpinned.length > 0) && !alreadyEnforced) {
    logger.warn(`[NLPWA] Active or pinned version is below minimum supported version (${minVersion}). Update required.`);
    await broadcast({
      type: MESSAGE_TYPES.UPDATE_REQUIRED,
      minVersion,
      activeVersion: active?.version || null,
      targetVersion: targetVersion || source?.version || null,
      unpinnedClients: unpinned,
    });
  }

  return true;
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

function stringHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

async function getRolloutCohort(targetVersion = '') {
  const SEED_KEY = '/_nlpwa/rollout-seed.json';
  const existing = await readMeta(SEED_KEY).catch(() => null);
  let seed;
  if (existing && typeof existing.seed === 'number') {
    seed = existing.seed;
  } else {
    seed = Math.floor(Math.random() * 100);
    await writeMeta(SEED_KEY, { seed, createdAt: Date.now() }).catch(() => {});
  }
  if (!targetVersion) return seed;
  // Rotate canary cohort per version using deterministic hash of seed + targetVersion
  return stringHash(`${seed}:${targetVersion}`) % 100;
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

  // If in cryptographic mode, verify signature on Tier 1 version response before trusting metadata
  let isTier1Trusted = !config.publicKey;
  if (config.publicKey && versionRes) {
    if (versionRes.signature) {
      try {
        isTier1Trusted = await verifyManifestSignature(versionRes, config.publicKey);
        if (!isTier1Trusted) {
          logger.warn('[NLPWA] Tier 1 version.json signature verification failed; falling back to Tier 2 manifest.');
        } else {
          // Monotonic sequence verification on Tier 1 (prevent replaying old signed version.json)
          const seq = versionRes.sequence;
          if (typeof seq !== 'number' || !Number.isFinite(seq)) {
            logger.warn('[NLPWA] Tier 1 version.json missing required numeric sequence in signed mode; falling back to Tier 2.');
            isTier1Trusted = false;
          } else {
            const lastSeqData = await readMeta('/_nlpwa/sequence.json').catch(() => null);
            const lastSeq = Number(lastSeqData?.sequence) || 0;
            if (seq < lastSeq) {
              logger.warn(`[NLPWA] Replay attack detected on Tier 1: sequence (${seq}) is older than last seen (${lastSeq}); falling back to Tier 2.`);
              isTier1Trusted = false;
            } else {
              // Persist monotonic sequence progression immediately on trusted Tier 1 checks
              await writeMeta('/_nlpwa/sequence.json', { sequence: seq, updatedAt: Date.now() }).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn('[NLPWA] Tier 1 signature verification error:', err?.message || err);
        isTier1Trusted = false;
      }
    } else {
      logger.warn('[NLPWA] Tier 1 version.json is unsigned while publicKey is configured; falling back to Tier 2 manifest.');
      isTier1Trusted = false;
    }
  }

  // If Tier 1 is untrusted, discard untrusted metadata completely to prevent freeze/bypass attacks
  if (!isTier1Trusted) {
    versionRes = null;
    serverVersion = null;
  }

  // Synchronize blocked versions list from Tier 1 ONLY if trusted
  if (isTier1Trusted && Array.isArray(versionRes?.blockedVersions)) {
    await syncBlockedVersions(versionRes.blockedVersions);
  }

  const discardStaged = async (reason = '') => {
    if (staged) {
      await withLock(async () => {
        const activePart = active?.version ? ` (active: v${active.version})` : '';
        const reasonPart = reason ? `: ${reason}` : '';
        logger.log(`[NLPWA] Clearing staged update v${staged.version}${activePart}${reasonPart}`);
        await clearStaged();
        if (staged.cache) {
          await caches.delete(staged.cache).catch((err) => {
            logger.debug('[NLPWA] Failed to delete staged cache:', err?.message || err);
          });
        }
      });
    }
  };

  // If active version has been blocked by remote kill-switch, execute emergency rollback
  if (active?.version && (await isVersionBlocked(active.version))) {
    logger.warn(`[NLPWA] Active version v${active.version} is blocked by remote kill-switch. Triggering emergency rollback...`);
    const rollbackRes = await rollbackToFallback(`Active version v${active.version} is blocked`);
    if (rollbackRes.success) {
      await discardStaged('active version blocked');
      setUpdateStatus('idle');
      return { updated: false, rolledBack: true, version: rollbackRes.version };
    }
  }

  // Check minimum supported version from Tier 1 if present and trusted
  let tier1Enforced = false;
  if (isTier1Trusted) {
    tier1Enforced = await enforceMinVersion(versionRes, {
      active,
      targetVersion: serverVersion,
    });
  }

  // If server target version is blocked, do not stage it
  if (serverVersion && (await isVersionBlocked(serverVersion))) {
    logger.warn(`[NLPWA] Target version v${serverVersion} is blocked. Skipping update.`);
    await discardStaged(`target version v${serverVersion} blocked`);
    setUpdateStatus('idle');
    return { updated: false, blocked: true, version: serverVersion };
  }

  // Check release channel filter: persisted client subscription in IndexedDB overrides static config
  const persistedChannel = (await readMeta('/_nlpwa/channel.json'))?.channel;
  const activeChannel = persistedChannel !== undefined ? persistedChannel : config.channel;
  if (!force && activeChannel && versionRes?.channel && activeChannel !== versionRes.channel) {
    logger.log(`[NLPWA] Skipping release channel "${versionRes.channel}" (configured channel: "${activeChannel}").`);
    return { updated: false, channelMismatch: true };
  }

  // Check phased rollout percentage
  if (!force && typeof versionRes?.rolloutPercent === 'number') {
    const pct = versionRes.rolloutPercent;
    if (pct >= 0 && pct < 100) {
      const cohort = await getRolloutCohort(serverVersion);
      if (cohort >= pct) {
        logger.log(`[NLPWA] Client cohort (${cohort}) excluded from phased rollout of v${serverVersion} (${pct}%).`);
        return { updated: false, rolloutExcluded: true, rolloutPercent: pct };
      }
    }
  }

  // A complete update is already staged and waiting for the next navigation, and the server confirms it.
  if (staged?.complete && staged.swVersion === config.version
      && serverVersion && serverVersion === staged.version) {
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

  if (serverVersion && isCurrent(serverVersion)) {
    await discardStaged(`server rolled back to v${active?.version}`);
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
    if (staged?.complete && staged.swVersion === config.version) {
      await broadcast({ type: MESSAGE_TYPES.UPDATE_READY, version: staged.version, staged: true });
      return { updated: true, version: staged.version, staged: true };
    }
    return { updated: false };
  }

  // Cryptographic Ed25519 signature verification
  if (config.publicKey) {
    let isValid = false;
    try {
      isValid = await verifyManifestSignature(serverManifest, config.publicKey);
    } catch (err) {
      logger.error('[NLPWA] Manifest signature verification error:', err?.message || err);
    }

    if (!isValid) {
      logger.error(`[NLPWA] Signature verification FAILED for v${serverManifest.version}! Untrusted manifest rejected.`);
      await discardStaged('manifest signature verification failed');
      setUpdateStatus('idle');
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_FAILED,
        errorCode: 'SIGNATURE_VERIFICATION_FAILED',
        version: serverManifest.version,
        error: `Manifest signature verification failed for v${serverManifest.version}`,
      });
      return {
        updated: false,
        errorCode: 'SIGNATURE_VERIFICATION_FAILED',
        version: serverManifest.version,
        error: 'Signature verification failed',
      };
    }
    logger.log(`[NLPWA] Ed25519 manifest signature verified for v${serverManifest.version}.`);

    // Monotonic sequence verification (Replay & downgrade attack mitigation)
    const seq = serverManifest.sequence;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      logger.error(`[NLPWA] Replay attack mitigation failed: manifest for v${serverManifest.version} is missing a required numeric sequence in signed mode.`);
      await discardStaged('manifest sequence required in signed mode');
      setUpdateStatus('idle');
      return { updated: false, errorCode: 'SEQUENCE_REQUIRED', version: serverManifest.version };
    }

    const lastSeqData = await readMeta('/_nlpwa/sequence.json').catch(() => null);
    const lastSeq = Number(lastSeqData?.sequence) || 0;
    if (seq < lastSeq) {
      logger.error(`[NLPWA] Replay attack detected: manifest sequence (${seq}) is older than last seen (${lastSeq}).`);
      await discardStaged('manifest sequence replay detected');
      setUpdateStatus('idle');
      return { updated: false, errorCode: 'REPLAY_DETECTED', version: serverManifest.version };
    }
  }

  // Synchronize blocked versions list from Tier 2 once verified
  if (Array.isArray(serverManifest?.blockedVersions)) {
    await syncBlockedVersions(serverManifest.blockedVersions);
  }

  if (await isVersionBlocked(serverManifest.version)) {
    logger.warn(`[NLPWA] Manifest version v${serverManifest.version} is blocked. Skipping staging.`);
    await discardStaged(`manifest version v${serverManifest.version} blocked`);
    setUpdateStatus('idle');
    return { updated: false, blocked: true, version: serverManifest.version };
  }

  if (!force && activeChannel && serverManifest.channel && activeChannel !== serverManifest.channel) {
    logger.log(`[NLPWA] Skipping manifest release channel "${serverManifest.channel}" (configured channel: "${activeChannel}").`);
    return { updated: false, channelMismatch: true };
  }

  // Check phased rollout percentage from Tier 2 manifest
  if (!force && typeof serverManifest.rolloutPercent === 'number') {
    const pct = serverManifest.rolloutPercent;
    if (pct >= 0 && pct < 100) {
      const cohort = await getRolloutCohort(serverManifest.version);
      if (cohort >= pct) {
        logger.log(`[NLPWA] Client cohort (${cohort}) excluded from phased rollout of v${serverManifest.version} (${pct}%).`);
        return { updated: false, rolloutExcluded: true, rolloutPercent: pct };
      }
    }
  }

  // Check minimum supported version from Tier 2 manifest
  await enforceMinVersion(serverManifest, {
    active,
    alreadyEnforced: tier1Enforced,
    targetVersion: serverManifest.version,
  });

  if (isCurrent(serverManifest.version)) {
    await discardStaged(`server rolled back to v${active?.version}`);
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

    if (result.status === 'deferred') {
      setUpdateStatus('idle');
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_DEFERRED,
        version: serverManifest.version,
        reason: result.reason,
        estimatedDeltaBytes: result.estimatedDeltaBytes,
        wifiOnlyThresholdBytes: result.wifiOnlyThresholdBytes,
      });
      return {
        updated: false,
        deferred: true,
        reason: result.reason,
        version: serverManifest.version,
        estimatedDeltaBytes: result.estimatedDeltaBytes,
      };
    }

    if (result.status === 'budget-exceeded') {
      setUpdateStatus('idle');
      const errorMsg = `Update delta (${result.estimatedDeltaBytes} bytes) exceeds budget of ${result.maxUpdateBytes} bytes`;
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_FAILED,
        errorCode: 'BUDGET_EXCEEDED',
        version: serverManifest.version,
        error: errorMsg,
        estimatedDeltaBytes: result.estimatedDeltaBytes,
        maxUpdateBytes: result.maxUpdateBytes,
      });
      return {
        updated: false,
        errorCode: 'BUDGET_EXCEEDED',
        version: serverManifest.version,
        error: errorMsg,
        estimatedDeltaBytes: result.estimatedDeltaBytes,
        maxUpdateBytes: result.maxUpdateBytes,
      };
    }

    if (result.status === 'downloading-background') {
      setUpdateStatus('staging');
      logger.log(`[NLPWA] Staging continuing in background via Background Fetch (${result.pendingBackgroundFetches.length} file(s) downloading).`);
      return {
        updated: false,
        downloading: true,
        pendingBackgroundFetches: result.pendingBackgroundFetches,
        version: serverManifest.version,
      };
    }

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

    if (serverManifest.sequence !== undefined) {
      await writeMeta('/_nlpwa/sequence.json', { sequence: serverManifest.sequence, updatedAt: Date.now() }).catch(() => {});
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
