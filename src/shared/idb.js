/**
 * Lightweight, zero-dependency, connection-pooled IndexedDB utility.
 * Shared across Service Worker and Client contexts.
 *
 * Includes transparent in-memory fallback for restrictive environments
 * (e.g. private browsing, locked-down profiles, or headless test runners).
 */

const _dbCache = new Map();
const _memStores = new Map();

function getIDB() {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB;
  return null;
}

function getMemStore(dbName, storeName) {
  const compositeKey = `${dbName}:${storeName}`;
  if (!_memStores.has(compositeKey)) {
    _memStores.set(compositeKey, new Map());
  }
  return _memStores.get(compositeKey);
}

/**
 * Open an IndexedDB database with connection caching.
 *
 * @param {string} dbName
 * @param {number} [version=1]
 * @param {(db: IDBDatabase, oldVersion: number, newVersion: number) => void} [onUpgrade]
 * @returns {Promise<IDBDatabase|null>}
 */
export function openDB(dbName, version = 1, onUpgrade) {
  const idb = getIDB();
  if (!idb) return Promise.resolve(null);

  const cacheKey = `${dbName}:${version}`;
  if (_dbCache.has(cacheKey)) {
    return _dbCache.get(cacheKey);
  }

  const promise = new Promise((resolve, reject) => {
    try {
      const request = idb.open(dbName, version);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (typeof onUpgrade === 'function') {
          onUpgrade(db, event.oldVersion, event.newVersion);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          _dbCache.delete(cacheKey);
        };
        resolve(db);
      };

      request.onerror = () => {
        _dbCache.delete(cacheKey);
        reject(request.error || new Error(`Failed to open IndexedDB "${dbName}"`));
      };

      request.onblocked = () => {
        console.warn(`[NLPWA IDB] Database "${dbName}" open blocked by open tab.`);
      };
    } catch (err) {
      _dbCache.delete(cacheKey);
      reject(err);
    }
  }).catch((err) => {
    console.warn(`[NLPWA IDB] Falling back to in-memory store for "${dbName}":`, err?.message || err);
    return null;
  });

  _dbCache.set(cacheKey, promise);
  return promise;
}

/**
 * Execute a transaction on an object store.
 *
 * @template T
 * @param {string} dbName
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore, tx: IDBTransaction) => Promise<T>|T} callback
 * @param {(db: IDBDatabase) => void} [ensureStore]
 * @returns {Promise<T>}
 */
export async function withStore(dbName, storeName, mode, callback, ensureStore) {
  let db = null;
  try {
    db = await openDB(dbName, 1, (database) => {
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
      if (typeof ensureStore === 'function') {
        ensureStore(database);
      }
    });
  } catch {
    db = null;
  }

  // Memory fallback if IndexedDB is not available or rejected
  if (!db || !db.objectStoreNames.contains(storeName)) {
    const mem = getMemStore(dbName, storeName);
    const mockStore = {
      get: (k) => ({ result: mem.get(k) }),
      put: (v, k) => { mem.set(k, v); return {}; },
      delete: (k) => { mem.delete(k); return {}; },
      clear: () => { mem.clear(); return {}; },
      getAll: () => ({ result: Array.from(mem.values()) }),
      getAllKeys: () => ({ result: Array.from(mem.keys()) }),
    };
    return Promise.resolve(callback(mockStore, null));
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);

      let result;
      let callbackDone = false;
      let txCompleted = false;

      const tryResolve = () => {
        if (callbackDone && (txCompleted || mode === 'readonly')) {
          resolve(result);
        }
      };

      tx.onerror = () => reject(tx.error || new Error('IDB Transaction error'));
      tx.onabort = () => reject(tx.error || new Error('IDB Transaction aborted'));
      tx.oncomplete = () => {
        txCompleted = true;
        tryResolve();
      };

      Promise.resolve(callback(store, tx))
        .then((r) => {
          result = r;
          callbackDone = true;
          tryResolve();
        })
        .catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Get a value by key from a store.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<any>}
 */
export async function idbGet(dbName, storeName, key) {
  return withStore(dbName, storeName, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Put a value by key into a store.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function idbSet(dbName, storeName, key, value) {
  return withStore(dbName, storeName, 'readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Delete a value by key from a store.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
export async function idbDel(dbName, storeName, key) {
  return withStore(dbName, storeName, 'readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Clear all values in a store.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @returns {Promise<void>}
 */
export async function idbClear(dbName, storeName) {
  return withStore(dbName, storeName, 'readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Get all keys in a store.
 *
 * @param {string} dbName
 * @param {string} storeName
 * @returns {Promise<IDBValidKey[]>}
 */
export async function idbKeys(dbName, storeName) {
  return withStore(dbName, storeName, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Reset memory fallback stores and connection cache (for tests/teardown).
 */
export function resetIDBCache() {
  _dbCache.clear();
  _memStores.clear();
}
