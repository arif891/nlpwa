import { idbGet, idbSet, idbDel } from '../../../shared/idb.js';
import { compare } from '../../../shared/version.js';

export let META_CACHE = 'nlpwa-meta';

/**
 * Get current meta database/store name.
 * @returns {string}
 */
export function getMetaCacheName() {
  return META_CACHE;
}

/**
 * Configure the meta database name (invoked during initConfig).
 * @param {string} name
 */
export function setMetaCacheName(name) {
  if (name && typeof name === 'string') {
    META_CACHE = name;
  }
}

export async function readMeta(key) {
  try {
    return await idbGet(META_CACHE, 'meta', key);
  } catch {
    return null;
  }
}

export async function writeMeta(key, value) {
  await idbSet(META_CACHE, 'meta', key, value);
}

export async function deleteMeta(key) {
  await idbDel(META_CACHE, 'meta', key);
}

export async function clearMetaStore() {
  const { idbClear } = await import('../../../shared/idb.js');
  await idbClear(META_CACHE, 'meta');
}

const MIN_VERSION_KEY = '/_nlpwa/min-version.json';

export async function getMinVersion() {
  const data = await readMeta(MIN_VERSION_KEY).catch(() => null);
  return data?.minVersion || null;
}

export async function setMinVersion(minVersion) {
  if (minVersion) {
    const current = await getMinVersion();
    if (!current || compare(minVersion, current) > 0) {
      await writeMeta(MIN_VERSION_KEY, { minVersion });
    }
  } else {
    await deleteMeta(MIN_VERSION_KEY);
  }
}

