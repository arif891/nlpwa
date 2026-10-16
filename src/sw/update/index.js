import { getConfig } from '../config/index.js';
import { fetchServerVersion, fetchServerManifest, loadCachedManifest, saveCachedManifest } from './manifest.js';
import { computeDiff, computeRefreshDiff } from './diff.js';
import { applyDiff } from './apply.js';
import { precacheFiles } from '../cache/index.js';
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
 *   1. Tier 1: Lightweight version check (/api/update/version)
 *   2. Check if App version is newer than cached manifest (stop early if not)
 *   3. Check if SW engine version changed
 *   4. Tier 2: Fetch full file manifest (/api/update/info)
 *   5. Hash diff against cached manifest
 *   6. Apply diff (fetch changed files & config.json, delete removed, evict stale)
 *   7. Broadcast UPDATE_READY to all clients
 *
 * This function is safe to call concurrently — a module-level lock
 * prevents overlapping update runs.
 *
 * @returns {Promise<{ updated: boolean, version?: string }>}
 */
let _updateInProgress = false;

export async function checkForUpdate() {
  if (_updateInProgress) {
    console.log('[NLPWA] Update already in progress, skipping.');
    return { updated: false };
  }

  _updateInProgress = true;

  try {
    const config = getConfig();

    // ── Tier 1: Lightweight version check ──────────────────────────────────
    let versionInfo;
    try {
      versionInfo = await fetchServerVersion();
    } catch (err) {
      console.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest if available:', err.message);
    }

    const cachedManifest = await loadCachedManifest();
    const serverVersion = versionInfo?.version;

    // Check if this is a fresh install (no snapshot stored yet)
    const isFreshInstall = !cachedManifest;

    // Check if SW engine version changed (developer manually bumped config.version)
    const swVersionChanged = cachedManifest?.swVersion && cachedManifest.swVersion !== config.version;

    // Check if previous update had failed fetches that need retry
    const needsRetry = Boolean(cachedManifest?.needsRetry);

    // Short-circuit if app version matches server, no SW change, and no retry needed
    if (!isFreshInstall && !swVersionChanged && !needsRetry && serverVersion && serverVersion === cachedManifest.version) {
      console.log(`[NLPWA] App already up to date (v${cachedManifest.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: cachedManifest.version });
      return { updated: false };
    }

    // ── Tier 2: Fetch server manifest ──────────────────────────────────────
    let serverManifest;
    try {
      serverManifest = await fetchServerManifest();
    } catch (err) {
      console.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
      return { updated: false };
    }

    // Handle SW engine version bump safely (populate new files before clearing old runtime)
    if (swVersionChanged) {
      console.log(`[NLPWA] SW engine version changed: v${cachedManifest.swVersion} → v${config.version}. Updating cache.`);
      await precacheFiles();
      // Re-fetch everything, but still drop files that no longer exist in the manifest
      const diff = computeRefreshDiff(serverManifest.files, cachedManifest.files);
      await applyDiff(diff, serverManifest);
      const { caches: cacheNames } = config;
      await caches.delete(cacheNames.runtime);
      await broadcast({
        type:    MESSAGE_TYPES.UPDATE_READY,
        version: serverManifest.version,
      });
      return { updated: true, version: serverManifest.version };
    }

    // Check if App version matches and no retry needed
    if (!isFreshInstall && !needsRetry && cachedManifest?.version === serverManifest.version) {
      console.log(`[NLPWA] App already up to date (v${cachedManifest.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: cachedManifest.version });
      return { updated: false };
    }

    // Fresh install: populate snapshot without showing "Update Available" banner
    if (isFreshInstall) {
      console.log(`[NLPWA] Initial installation: populating snapshot v${serverManifest.version}`);
      const diff = computeDiff(serverManifest.files, null);
      await applyDiff(diff, serverManifest);
      return { updated: false, version: serverManifest.version, initial: true };
    }

    console.log(`[NLPWA] Update available: v${cachedManifest.version} → v${serverManifest.version}${needsRetry ? ' (retrying previous failures)' : ''}`);

    // ── Step 3: Hash diff ──────────────────────────────────────────────────
    const diff = computeDiff(serverManifest.files, cachedManifest?.files ?? null);
    const hasChanges = diff.added.length + diff.modified.length + diff.removed.length > 0;

    // ── Step 4: Apply diff ─────────────────────────────────────────────────
    let applyResult = { success: true, applied: 0 };
    if (hasChanges) {
      applyResult = await applyDiff(diff, serverManifest);
    } else {
      await saveCachedManifest(serverManifest);
      console.log(`[NLPWA] Version updated (no file changes): v${serverManifest.version}`);
    }

    // ── Step 5: Notify clients ─────────────────────────────────────────────
    // Notify on full success, and also on partial success: files that did
    // download are already live in the cache, so clients should know to reload.
    const somethingApplied = applyResult.success || applyResult.applied > 0;
    if (somethingApplied) {
      await broadcast({
        type:    MESSAGE_TYPES.UPDATE_READY,
        version: serverManifest.version,
        partial: !applyResult.success,
      });
    }

    return { updated: somethingApplied, version: serverManifest.version };

  } finally {
    _updateInProgress = false;
  }
}

/**
 * Start automatic update polling based on config.updateCheckInterval.
 * No-op if updateCheckInterval is 0 (manual-only mode).
 */
export function startUpdatePolling() {
  const { updateCheckInterval } = getConfig();
  if (!updateCheckInterval) return;

  const intervalMs = updateCheckInterval;
  console.log(`[NLPWA] Update polling every ${intervalMs / 1000}s`);

  setInterval(() => {
    checkForUpdate().catch(err => console.error('[NLPWA] Update check error:', err));
  }, intervalMs);
}
