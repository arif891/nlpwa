import { readMeta, writeMeta, deleteMeta } from './store.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger();
export const BLOCKED_VERSIONS_KEY = '/_nlpwa/blocked-versions.json';

let _blockedMemo = null;

/**
 * Get the list of all active (non-expired) blocked version strings.
 *
 * @returns {Promise<string[]>}
 */
export async function getBlockedVersions() {
  const data = await readMeta(BLOCKED_VERSIONS_KEY).catch(() => null);
  const now = Date.now();
  let changed = false;

  const validVersions = [];
  const entries = data?.entries || {};

  // Support legacy format { versions: [...] }
  if (Array.isArray(data?.versions)) {
    for (const v of data.versions) {
      if (!entries[v]) {
        entries[v] = { blockedAt: data.updatedAt || now, ttlMs: 24 * 60 * 60 * 1000 };
      }
    }
  }

  for (const [v, meta] of Object.entries(entries)) {
    const ttl = meta?.ttlMs ?? (24 * 60 * 60 * 1000);
    if (ttl > 0 && (now - (meta?.blockedAt || 0)) > ttl) {
      delete entries[v];
      changed = true;
    } else {
      validVersions.push(v);
    }
  }

  if (changed) {
    await writeMeta(BLOCKED_VERSIONS_KEY, {
      versions: validVersions,
      entries,
      updatedAt: now,
    }).catch(() => {});
  }

  _blockedMemo = new Set(validVersions);
  return [...validVersions];
}

/**
 * Check if a specific version string is currently blocked.
 *
 * @param {string} version
 * @returns {Promise<boolean>}
 */
export async function isVersionBlocked(version) {
  if (!version) return false;
  const versions = await getBlockedVersions();
  return versions.includes(version);
}

/**
 * Block a version so it cannot be staged or activated, and triggers rollback if active.
 * Client-side blocks have a 24h TTL by default.
 *
 * @param {string} version
 * @param {string} [reason]
 * @param {Object} [options]
 * @param {number} [options.ttlMs=86400000]
 * @returns {Promise<string[]>} Updated blocked versions list
 */
export async function blockVersion(version, reason = '', { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!version || typeof version !== 'string') return getBlockedVersions();

  const data = await readMeta(BLOCKED_VERSIONS_KEY).catch(() => null);
  const entries = data?.entries || {};
  entries[version] = {
    blockedAt: Date.now(),
    ttlMs,
    reason,
  };
  const versions = Object.keys(entries);
  _blockedMemo = new Set(versions);
  await writeMeta(BLOCKED_VERSIONS_KEY, {
    versions,
    entries,
    updatedAt: Date.now(),
    lastReason: reason,
  });
  logger.warn(`[NLPWA] Version v${version} has been blocked (TTL: ${ttlMs}ms).${reason ? ` Reason: ${reason}` : ''}`);
  return [...versions];
}

/**
 * Unblock a version.
 *
 * @param {string} version
 * @returns {Promise<string[]>}
 */
export async function unblockVersion(version) {
  if (!version) return getBlockedVersions();

  const data = await readMeta(BLOCKED_VERSIONS_KEY).catch(() => null);
  const entries = data?.entries || {};
  delete entries[version];
  const versions = Object.keys(entries);
  _blockedMemo = new Set(versions);
  await writeMeta(BLOCKED_VERSIONS_KEY, {
    versions,
    entries,
    updatedAt: Date.now(),
  });
  return [...versions];
}

/**
 * Synchronize blocked versions from a remote manifest (e.g. version.json blockedVersions array).
 *
 * @param {string[]} remoteBlocked
 * @returns {Promise<string[]>}
 */
export async function syncBlockedVersions(remoteBlocked) {
  if (!Array.isArray(remoteBlocked)) {
    return getBlockedVersions();
  }

  const current = await getBlockedVersions();
  const data = await readMeta(BLOCKED_VERSIONS_KEY).catch(() => null);
  const entries = data?.entries || {};
  let changed = false;

  const remoteSet = new Set(remoteBlocked.filter((v) => typeof v === 'string'));

  // 1. Add newly blocked remote versions
  for (const v of remoteSet) {
    if (!entries[v]) {
      entries[v] = { blockedAt: Date.now(), ttlMs: 0, reason: 'Remote sync' };
      changed = true;
    }
  }

  // 2. Unblock versions previously synced from remote that are no longer in remoteBlocked
  for (const [v, meta] of Object.entries(entries)) {
    if (meta?.reason === 'Remote sync' && !remoteSet.has(v)) {
      delete entries[v];
      changed = true;
      logger.log(`[NLPWA] Version v${v} was removed from remote blocked list. Unblocked.`);
    }
  }

  if (changed) {
    const list = Object.keys(entries);
    _blockedMemo = new Set(list);
    await writeMeta(BLOCKED_VERSIONS_KEY, {
      versions: list,
      entries,
      updatedAt: Date.now(),
    });
    logger.log(`[NLPWA] Synchronized ${list.length} blocked version(s) from server.`);
    return list;
  }

  return current;
}

/**
 * Clear all blocked versions.
 */
export async function clearBlockedVersions() {
  await deleteMeta(BLOCKED_VERSIONS_KEY);
  _blockedMemo = null;
}

/**
 * Reset memory cache (for tests).
 */
export function resetBlockedVersionsMemo() {
  _blockedMemo = null;
}
