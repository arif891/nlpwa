import { createLogger } from '../../../shared/logger.js';

const logger = createLogger();

export let META_CACHE = 'nlpwa-meta';

/**
 * Get current meta cache name.
 * @returns {string}
 */
export function getMetaCacheName() {
  return META_CACHE;
}

/**
 * Configure the meta cache name (invoked during initConfig).
 * @param {string} name
 */
export function setMetaCacheName(name) {
  if (name && typeof name === 'string') {
    META_CACHE = name;
  }
}

export async function readMeta(key) {
  const cache = await caches.open(META_CACHE);
  const response = await cache.match(key);
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function writeMeta(key, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(key, new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

export async function deleteMeta(key) {
  const cache = await caches.open(META_CACHE);
  await cache.delete(key);
}

const MIN_VERSION_KEY = '/_nlpwa/min-version.json';

export async function getMinVersion() {
  const data = await readMeta(MIN_VERSION_KEY).catch(() => null);
  return data?.minVersion || null;
}

export async function setMinVersion(minVersion) {
  if (minVersion) {
    await writeMeta(MIN_VERSION_KEY, { minVersion });
  } else {
    await deleteMeta(MIN_VERSION_KEY);
  }
}

