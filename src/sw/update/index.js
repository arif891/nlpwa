import { getConfig } from '../config/index.js';
import { fetchServerManifest, loadCachedManifest, saveCachedManifest } from './manifest.js';
import { computeDiff } from './diff.js';
import { applyDiff } from './apply.js';
import { isNewer } from '../../shared/version.js';
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
 * Run a complete update check cycle:
 *
 *   1. Fetch /api/manifest/latest
 *   2. Version comparison (short-circuit if up to date)
 *   3. Hash diff against cached manifest
 *   4. Apply diff (fetch changed, delete removed, evict stale)
 *   5. Broadcast UPDATE_READY to all clients
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

    // ── Step 1: Fetch server manifest ──────────────────────────────────────
    let serverManifest;
    try {
      serverManifest = await fetchServerManifest();
    } catch (err) {
      console.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
      return { updated: false };
    }

    // ── Step 2: Version check ──────────────────────────────────────────────
    if (!isNewer(serverManifest.version, config.version)) {
      console.log(`[NLPWA] Already up to date (v${config.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: config.version });
      return { updated: false };
    }

    console.log(`[NLPWA] Update available: v${config.version} → v${serverManifest.version}`);

    // ── Step 3: Hash diff ──────────────────────────────────────────────────
    const cachedManifest = await loadCachedManifest();
    const diff = computeDiff(serverManifest.files, cachedManifest?.files ?? null);

    const hasChanges = diff.added.length + diff.modified.length + diff.removed.length > 0;

    // ── Step 4: Apply diff (or just save snapshot if only version changed) ─
    if (hasChanges) {
      await applyDiff(diff, serverManifest);
    } else {
      // Version bumped but all file hashes are identical → just save snapshot
      await saveCachedManifest(serverManifest);
      console.log(`[NLPWA] Version updated (no file changes): v${serverManifest.version}`);
    }

    // ── Step 5: Notify clients ─────────────────────────────────────────────
    await broadcast({
      type:    MESSAGE_TYPES.UPDATE_READY,
      version: serverManifest.version,
    });

    return { updated: true, version: serverManifest.version };

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
