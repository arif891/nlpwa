import {
  META_CACHE,
  getMetaCacheName,
  setMetaCacheName,
  readMeta,
  writeMeta,
  deleteMeta,
  clearMetaStore,
  getMinVersion,
  setMinVersion,
} from './store.js';
import {
  getActive,
  setActive,
  clearActive,
  getActiveName,
  openActive,
  getActiveSnapshotPaths,
  setActiveSnapshotPaths,
  resetActiveMemo,
  ACTIVE_KEY,
} from './active.js';
import {
  getStaged,
  setStaged,
  clearStaged,
  resetStagedMemo,
  STAGED_KEY,
} from './staged.js';
import {
  initClientPins,
  pinClient,
  touchClientPin,
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getClientPinStatus,
  PIN_STATES,
  getAllPinnedCaches,
  pruneClientPins,
  flushClientPins,
  unpinClientsBelowVersion,
  resetClientPinsMemo,
  PIN_GRACE_PERIOD_MS,
  PINS_KEY,
} from './client-pins.js';
import {
  getBlockedVersions,
  isVersionBlocked,
  blockVersion,
  unblockVersion,
  syncBlockedVersions,
  clearBlockedVersions,
  resetBlockedVersionsMemo,
  BLOCKED_VERSIONS_KEY,
} from './blocked-versions.js';
import {
  tryAcquire,
  release,
  withLock,
  resetLockState,
} from './lock.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger();

export async function resetMeta() {
  resetActiveMemo();
  resetStagedMemo();
  resetClientPinsMemo();
  resetBlockedVersionsMemo();
  await clearMetaStore().catch(() => {});
}

export function resetStoreMemo() {
  resetActiveMemo();
  resetStagedMemo();
  resetClientPinsMemo();
  resetBlockedVersionsMemo();
  resetLockState();
}

/**
 * Delete every offline cache that is neither in `keep` nor the runtime cache.
 *
 * @param {{ base: string, runtime: string, keep: Array<string|undefined> }} opts
 */
export async function cleanupCaches({ base, runtime, keep }) {
  const keepSet = new Set(keep.filter(Boolean));
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name !== runtime && name !== META_CACHE && !keepSet.has(name))
      .filter((name) => name === base || name.startsWith(`${base}@`))
      .map((name) => {
        logger.log(`[NLPWA] Removed old cache: ${name}`);
        return caches.delete(name);
      })
  );
}

export {
  META_CACHE,
  getMetaCacheName,
  setMetaCacheName,
  readMeta,
  writeMeta,
  deleteMeta,
  getActive,
  setActive,
  clearActive,
  getActiveName,
  openActive,
  getActiveSnapshotPaths,
  setActiveSnapshotPaths,
  resetActiveMemo,
  getStaged,
  setStaged,
  clearStaged,
  initClientPins,
  pinClient,
  touchClientPin,
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getClientPinStatus,
  PIN_STATES,
  getAllPinnedCaches,
  pruneClientPins,
  flushClientPins,
  unpinClientsBelowVersion,
  resetClientPinsMemo,
  PIN_GRACE_PERIOD_MS,
  getMinVersion,
  setMinVersion,
  tryAcquire,
  release,
  withLock,
  getBlockedVersions,
  isVersionBlocked,
  blockVersion,
  unblockVersion,
  syncBlockedVersions,
  clearBlockedVersions,
  resetBlockedVersionsMemo,
  BLOCKED_VERSIONS_KEY,
};
