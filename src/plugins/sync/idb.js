/**
 * Lightweight, zero-dependency IndexedDB wrapper for request serialization
 * and queue storage in both Service Worker and Window contexts.
 */

import { openDB } from '../../shared/idb.js';

const DB_NAME = 'nlpwa-sync-db';
const DB_VERSION = 1;
const STORE_NAME = 'sync_requests';

/**
 * Open or upgrade the NLPWA Sync IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function openSyncDB() {
  return openDB(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      store.createIndex('queueName', 'queueName', { unique: false });
      store.createIndex('timestamp', 'timestamp', { unique: false });
    }
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

    let result;
    let callbackDone = false;
    let txCompleted = false;

    tx.onerror = () => reject(tx.error || new Error('Transaction error'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    tx.oncomplete = () => {
      txCompleted = true;
      if (callbackDone) {
        resolve(result);
      }
    };

    try {
      Promise.resolve(callback(store, tx))
        .then((r) => {
          result = r;
          callbackDone = true;
          if (txCompleted) {
            resolve(result);
          }
        })
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

  const hasIdempotency = headers.some(([k]) => k.toLowerCase() === 'idempotency-key' || k.toLowerCase() === 'x-idempotency-key');
  const idempotencyKey = metadata.idempotencyKey || (hasIdempotency ? undefined : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `nlpwa-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`));

  return {
    url: request.url,
    method: request.method,
    headers,
    body,
    idempotencyKey,
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
  if (record.idempotencyKey && !headers.has('idempotency-key') && !headers.has('x-idempotency-key')) {
    headers.set('X-Idempotency-Key', record.idempotencyKey);
  }
  const init = {
    method: record.method || 'POST',
    headers,
  };

  if (record.body && record.method !== 'GET' && record.method !== 'HEAD') {
    init.body = record.body;
  }

  return new Request(record.url, init);
}
