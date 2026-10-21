import { openDB, idbGet, idbSet, idbDel } from '../../shared/idb.js';
import { logger } from '../logger.js';

export const LARGE_ASSETS_DB = 'nlpwa-large-assets';
export const LARGE_ASSETS_STORE = 'blobs';

function upgradeLargeAssetsDB(db) {
  if (!db.objectStoreNames.contains(LARGE_ASSETS_STORE)) {
    db.createObjectStore(LARGE_ASSETS_STORE);
  }
}

/**
 * Store a large asset in IndexedDB.
 *
 * @param {string} url
 * @param {Response} response
 * @returns {Promise<Response>} Cloned response
 */
export async function storeLargeAssetInIDB(url, response) {
  try {
    const clone = response.clone();
    const blob = await clone.blob();
    const headers = {};
    if (response.headers?.entries) {
      for (const [k, v] of response.headers.entries()) {
        headers[k] = v;
      }
    }
    await idbSet(
      LARGE_ASSETS_DB,
      LARGE_ASSETS_STORE,
      url,
      {
        blob,
        headers,
        status: response.status,
        statusText: response.statusText,
        size: blob.size,
        updatedAt: Date.now(),
      },
      upgradeLargeAssetsDB
    );
    logger.debug(`[NLPWA] Stored large asset in IndexedDB (${(blob.size / (1024 * 1024)).toFixed(1)} MB): ${url}`);
  } catch (err) {
    logger.debug('[NLPWA] Failed to store large asset in IndexedDB:', err?.message || err);
  }
  return response;
}

/**
 * Retrieve a large asset from IndexedDB.
 *
 * @param {string} url
 * @returns {Promise<Response|null>}
 */
export async function getLargeAssetFromIDB(url) {
  try {
    const entry = await idbGet(LARGE_ASSETS_DB, LARGE_ASSETS_STORE, url, upgradeLargeAssetsDB);
    if (!entry || !entry.blob) return null;
    return new Response(entry.blob, {
      status: entry.status || 200,
      statusText: entry.statusText || 'OK',
      headers: entry.headers || {},
    });
  } catch (err) {
    logger.debug('[NLPWA] Error reading large asset from IndexedDB:', err?.message || err);
    return null;
  }
}

/**
 * Delete a large asset from IndexedDB.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function deleteLargeAssetFromIDB(url) {
  try {
    return await idbDel(LARGE_ASSETS_DB, LARGE_ASSETS_STORE, url, upgradeLargeAssetsDB);
  } catch {
    return false;
  }
}
