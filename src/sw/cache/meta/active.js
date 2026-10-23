import { readMeta, writeMeta, deleteMeta } from './store.js';
import { createLogger } from '../../../shared/logger.js';
import { SNAPSHOT_CACHE_PATH } from '../../../shared/constants.js';

const logger = createLogger();
const ACTIVE_KEY = '/_nlpwa/active.json';

let _activePromise = null;
let _activeSnapshotPaths = null;

export function getActive() {
  if (!_activePromise) {
    _activePromise = (async () => {
      const record = await readMeta(ACTIVE_KEY).catch(() => null);
      if (!record || !record.cache) return null;

      try {
        if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
          const names = await caches.keys();
          if (!names.includes(record.cache)) {
            logger.warn(`[NLPWA] Active cache "${record.cache}" was evicted by the browser. Clearing stale active pointer.`);
            await deleteMeta(ACTIVE_KEY);
            return null;
          }
          const cache = await caches.open(record.cache);
          const snapshotPath = record.snapshotPath || SNAPSHOT_CACHE_PATH;
          const hasSnapshot = await cache.match(snapshotPath);
          if (!hasSnapshot) {
            const keys = await cache.keys();
            if (keys.length === 0) {
              logger.warn(`[NLPWA] Active cache "${record.cache}" is empty (likely evicted by the browser). Clearing stale active pointer.`);
              await deleteMeta(ACTIVE_KEY);
              return null;
            }
          }
          if (record.previousCache && !names.includes(record.previousCache)) {
            delete record.previousCache;
            await writeMeta(ACTIVE_KEY, record);
          }
        }
      } catch (err) {
        logger.warn('[NLPWA] Could not verify active cache validity:', err?.message || err);
      }

      return record;
    })().catch(() => {
      _activePromise = Promise.resolve(null);
      return null;
    });
  }
  return _activePromise;
}

export async function clearActive() {
  await deleteMeta(ACTIVE_KEY);
  _activePromise = Promise.resolve(null);
}

export async function getActiveName(baseName) {
  return (await getActive())?.cache ?? baseName;
}

export async function openActive(baseName) {
  return caches.open(await getActiveName(baseName));
}

/** The single atomic commit point of an update. */
export async function setActive(record) {
  await writeMeta(ACTIVE_KEY, record);
  _activePromise = Promise.resolve(record);
}

export function getActiveSnapshotPaths() {
  return _activeSnapshotPaths;
}

export function setActiveSnapshotPaths(paths) {
  _activeSnapshotPaths = paths ? (paths instanceof Set ? paths : new Set(paths)) : null;
}

export function resetActiveMemo() {
  _activePromise = null;
  _activeSnapshotPaths = null;
}

export { ACTIVE_KEY };
