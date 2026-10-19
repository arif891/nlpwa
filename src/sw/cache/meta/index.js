import {
  META_CACHE,
  getMetaCacheName,
  setMetaCacheName,
  readMeta,
  writeMeta,
  deleteMeta,
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
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getAllPinnedCaches,
  pruneClientPins,
  flushClientPins,
  resetClientPinsMemo,
  PINS_KEY,
} from './client-pins.js';
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
  await Promise.all([
    deleteMeta(ACTIVE_KEY),
    deleteMeta(STAGED_KEY),
    deleteMeta(PINS_KEY),
  ]);
}

export function resetStoreMemo() {
  resetActiveMemo();
  resetStagedMemo();
  resetClientPinsMemo();
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
  getStaged,
  setStaged,
  clearStaged,
  initClientPins,
  pinClient,
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getAllPinnedCaches,
  pruneClientPins,
  flushClientPins,
  tryAcquire,
  release,
  withLock,
};
