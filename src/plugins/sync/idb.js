/**
 * Lightweight, zero-dependency IndexedDB wrapper for request serialization
 * and queue storage in both Service Worker and Window contexts.
 */

const DB_NAME = 'nlpwa-sync-db';
const DB_VERSION = 1;
const STORE_NAME = 'sync_requests';

function getIDB() {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB;
  return null;
}

/**
 * Open or upgrade the NLPWA Sync IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function openSyncDB() {
  const idb = getIDB();
  if (!idb) {
    return Promise.reject(new Error('[NLPWA Sync] IndexedDB is not available in this environment.'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('queueName', 'queueName', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

/**
 * Run a transaction on the sync store.
 * @template T
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>|T} callback
 * @returns {Promise<T>}
 */
export async function withStore(mode, callback) {
  const db = await openSyncDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    tx.onerror = () => reject(tx.error || new Error('Transaction error'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

    try {
      Promise.resolve(callback(store, tx))
        .then(resolve)
        .catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Serialize a Fetch Request into a plain object storeable in IndexedDB.
 *
 * @param {Request} request
 * @param {Object} [metadata]
 * @returns {Promise<Object>}
 */
export async function serializeRequest(request, metadata = {}) {
  const headers = [];
  if (request.headers && typeof request.headers.forEach === 'function') {
    request.headers.forEach((val, key) => headers.push([key, val]));
  }

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await request.clone().arrayBuffer();
    } catch {
      body = null;
    }
  }

  return {
    url: request.url,
    method: request.method,
    headers,
    body,
    timestamp: Date.now(),
    retryCount: 0,
    ...metadata,
  };
}

/**
 * Deserialize a stored record back into a Fetch Request.
 *
 * @param {Object} record
 * @returns {Request}
 */
export function deserializeRequest(record) {
  const headers = new Headers(record.headers || []);
  const init = {
    method: record.method || 'POST',
    headers,
  };

  if (record.body && record.method !== 'GET' && record.method !== 'HEAD') {
    init.body = record.body;
  }

  return new Request(record.url, init);
}
