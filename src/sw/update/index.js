import { getConfig } from '../config/index.js';
import { getStaged, tryAcquire, release } from '../cache/store.js';
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
  if (!tryAcquire()) {
    console.log('[NLPWA] Update already in progress, skipping.');
    return { updated: false };
  }
  try {
    return await runUpdateCheck(options);
  } finally {
    release();
  }
}

async function runUpdateCheck({ force = false } = {}) {
  const config = getConfig();

  // ── Tier 1: lightweight version check ────────────────────────────────────
  let serverVersion;
  try {
    serverVersion = (await fetchServerVersion()).version;
  } catch (err) {
    console.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest:', err.message);
  }

  const active = await loadCachedSnapshot();
  const staged = await getStaged();

  // A complete update is already staged and waiting for the next navigation.
  if (staged?.complete && staged.swVersion === config.version
      && (!serverVersion || serverVersion === staged.version)) {
    await broadcast({ type: MESSAGE_TYPES.UPDATE_READY, version: staged.version, partial: Boolean(staged.partial), staged: true });
    return { updated: true, version: staged.version, staged: true };
  }

  // If a previous retry failed and backoff has not expired yet, skip this periodic check unless forced
  if (!force && staged && !staged.complete && staged.nextRetryAt && Date.now() < staged.nextRetryAt) {
    console.log(`[NLPWA] Staging retry in backoff until ${new Date(staged.nextRetryAt).toISOString()}`);
    return { updated: false, backingOff: true };
  }

  const isFresh = !active;
  const swVersionChanged = Boolean(active?.swVersion && active.swVersion !== config.version);
  const needsRetry = Boolean(active?.needsRetry || (active?.degraded && active.degraded.length > 0));
  const isCurrent = (version) => !isFresh && !swVersionChanged && !needsRetry && version === active.version;

  if (serverVersion && isCurrent(serverVersion)) {
    console.log(`[NLPWA] App already up to date (v${active.version})`);
    await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
    return { updated: false };
  }

  // ── Tier 2: full manifest ────────────────────────────────────────────────
  let serverManifest;
  try {
    serverManifest = await fetchServerInfo();
  } catch (err) {
    console.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
    return { updated: false };
  }

  if (isCurrent(serverManifest.version)) {
    console.log(`[NLPWA] App already up to date (v${active.version})`);
    await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
    return { updated: false };
  }

  console.log(isFresh
    ? `[NLPWA] Initial installation: staging v${serverManifest.version}`
    : `[NLPWA] Update available: v${active.version} → v${serverManifest.version}`);

  // ── Stage (active version keeps serving) ─────────────────────────────────
  const result = await stageUpdate(serverManifest, { activeSnapshot: active, forceRefetch: swVersionChanged });

  if (result.status === 'incomplete') {
    const errorMsg = result.hasHashMismatch
      ? `Hash mismatch verification failed for ${result.failed.join(', ')}`
      : result.quotaExceeded
        ? `Storage quota exceeded while staging ${result.failed.join(', ')}`
        : `Failed to download or verify ${result.failed.join(', ')}`;

    await broadcast({
      type: MESSAGE_TYPES.UPDATE_FAILED,
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

    return { updated: false, version: serverManifest.version, failed: result.failed, error: errorMsg, quotaExceeded: Boolean(result.quotaExceeded) };
  }

  if (isFresh) {
    await commitStaged();
    return { updated: false, version: serverManifest.version, initial: true };
  }

  await broadcast({
    type: MESSAGE_TYPES.UPDATE_READY,
    version: serverManifest.version,
    partial: result.partial,
    staged: true,
  });
  return { updated: true, version: serverManifest.version, staged: true };
}
