/**
 * Storage persistence and quota helpers for the NLPWA Client SDK.
 */

/**
 * Check whether storage persistence is already granted by the browser.
 *
 * @returns {Promise<boolean>}
 */
export async function isStoragePersistent() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persisted !== 'function'
  ) {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Request persistent storage from the browser.
 * When granted, CacheStorage and IndexedDB will not be cleared under disk pressure.
 *
 * @returns {Promise<boolean>} Resolves to true if persistent storage was granted
 */
export async function requestPersistentStorage() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persist !== 'function'
  ) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
