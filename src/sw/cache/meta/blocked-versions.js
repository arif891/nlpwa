import { readMeta, writeMeta, deleteMeta } from './store.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger();
export const BLOCKED_VERSIONS_KEY = '/_nlpwa/blocked-versions.json';

let _blockedMemo = null;

/**
 * Get the list of all blocked/blacklisted version strings.
 *
 * @returns {Promise<string[]>}
 */
export async function getBlockedVersions() {
  if (_blockedMemo) return [..._blockedMemo];

  const data = await readMeta(BLOCKED_VERSIONS_KEY).catch(() => null);
  const list = Array.isArray(data?.versions) ? data.versions : [];
  _blockedMemo = new Set(list);
  return [..._blockedMemo];
}

/**
 * Check if a specific version string is currently blocked.
 *
 * @param {string} version
 * @returns {Promise<boolean>}
 */
export async function isVersionBlocked(version) {
  if (!version) return false;
  if (_blockedMemo) {
    return _blockedMemo.has(version);
  }
  const versions = await getBlockedVersions();
  return versions.includes(version);
}

/**
 * Block a version so it cannot be staged or activated, and triggers rollback if active.
 *
 * @param {string} version
 * @param {string} [reason]
 * @returns {Promise<string[]>} Updated blocked versions list
 */
export async function blockVersion(version, reason = '') {
  if (!version || typeof version !== 'string') return getBlockedVersions();

  const current = await getBlockedVersions();
  if (!current.includes(version)) {
    current.push(version);
    _blockedMemo = new Set(current);
    await writeMeta(BLOCKED_VERSIONS_KEY, {
      versions: current,
      updatedAt: Date.now(),
      ...(reason ? { lastReason: reason } : {}),
    });
    logger.warn(`[NLPWA] Version v${version} has been blocked.${reason ? ` Reason: ${reason}` : ''}`);
  }
  return [...current];
}

/**
 * Unblock a version.
 *
 * @param {string} version
 * @returns {Promise<string[]>}
 */
export async function unblockVersion(version) {
  if (!version) return getBlockedVersions();

  const current = await getBlockedVersions();
  const next = current.filter((v) => v !== version);
  _blockedMemo = new Set(next);
  await writeMeta(BLOCKED_VERSIONS_KEY, {
    versions: next,
    updatedAt: Date.now(),
  });
  return [...next];
}

/**
 * Synchronize blocked versions from a remote manifest (e.g. version.json blockedVersions array).
 *
 * @param {string[]} remoteBlocked
 * @returns {Promise<string[]>}
 */
export async function syncBlockedVersions(remoteBlocked) {
  if (!Array.isArray(remoteBlocked) || remoteBlocked.length === 0) {
    return getBlockedVersions();
  }

  const current = await getBlockedVersions();
  const set = new Set(current);
  let changed = false;

  for (const v of remoteBlocked) {
    if (typeof v === 'string' && !set.has(v)) {
      set.add(v);
      changed = true;
    }
  }

  if (changed) {
    const list = Array.from(set);
    _blockedMemo = set;
    await writeMeta(BLOCKED_VERSIONS_KEY, {
      versions: list,
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
