/**
 * In-memory IndexedDB fake for running background sync and IDB tests in Node.
 */

class FakeIDBKeyRange {
  constructor(val) {
    this.value = val;
  }
  static only(val) {
    return new FakeIDBKeyRange(val);
  }
}

class FakeIDBCursor {
  constructor(items, store, onDone) {
    this.items = items;
    this.index = 0;
    this.store = store;
    this.onDone = onDone;
  }
  get result() {
    if (this.index >= this.items.length) return null;
    return this;
  }
  get value() {
    return this.items[this.index];
  }
  continue() {
    this.index++;
    this.onDone(this.result);
  }
  delete() {
    const item = this.items[this.index];
    if (item && item.id != null) {
      this.store.records.delete(item.id);
    }
  }
}

class FakeIDBIndex {
  constructor(name, keyPath, store) {
    this.name = name;
    this.keyPath = keyPath;
    this.store = store;
  }
  getAll(range) {
    const req = { onsuccess: null, onerror: null, result: [] };
    queueMicrotask(() => {
      const all = Array.from(this.store.records.values());
      const filtered = range?.value !== undefined
        ? all.filter((r) => r[this.keyPath] === range.value)
        : all;
      req.result = filtered;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  openCursor(range) {
    const req = { onsuccess: null, onerror: null };
    queueMicrotask(() => {
      const all = Array.from(this.store.records.values());
      const filtered = range?.value !== undefined
        ? all.filter((r) => r[this.keyPath] === range.value)
        : all;
      const cursor = new FakeIDBCursor(filtered, this.store, (next) => {
        if (req.onsuccess) req.onsuccess({ target: { result: next } });
      });
      if (req.onsuccess) req.onsuccess({ target: { result: cursor.result } });
    });
    return req;
  }
}

class FakeIDBObjectStore {
  constructor(name, options = {}) {
    this.name = name;
    this.keyPath = options.keyPath || 'id';
    this.autoIncrement = Boolean(options.autoIncrement);
    this.records = new Map();
    this.indexes = new Map();
    this.nextId = 1;
  }
  createIndex(name, keyPath, options) {
    const idx = new FakeIDBIndex(name, keyPath, this);
    this.indexes.set(name, idx);
    return idx;
  }
  index(name) {
    return this.indexes.get(name);
  }
  add(record) {
    const req = { onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      const id = this.autoIncrement ? this.nextId++ : (record[this.keyPath] || this.nextId++);
      const toStore = { ...record, [this.keyPath]: id };
      this.records.set(id, toStore);
      req.result = id;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  put(record) {
    const req = { onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      const id = record[this.keyPath] || this.nextId++;
      this.records.set(id, { ...record, [this.keyPath]: id });
      req.result = id;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  get(id) {
    const req = { onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      req.result = this.records.get(id) || null;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  delete(id) {
    const req = { onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      this.records.delete(id);
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  clear() {
    const req = { onsuccess: null, onerror: null };
    queueMicrotask(() => {
      this.records.clear();
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
}

class FakeIDBDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (n) => this.stores.has(n),
    };
  }
  createObjectStore(name, options) {
    const store = new FakeIDBObjectStore(name, options);
    this.stores.set(name, store);
    return store;
  }
  transaction(storeNames, mode) {
    const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    const store = this.stores.get(storeName);
    const tx = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => store,
    };
    queueMicrotask(() => {
      if (tx.oncomplete) tx.oncomplete();
    });
    return tx;
  }
}

export class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
  }
  open(name, version = 1) {
    const req = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: null,
    };
    queueMicrotask(() => {
      let db = this.databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeIDBDatabase(name, version);
        this.databases.set(name, db);
      }
      req.result = db;
      if (isNew && req.onupgradeneeded) {
        req.onupgradeneeded({ target: req });
      }
      if (req.onsuccess) {
        req.onsuccess({ target: req });
      }
    });
    return req;
  }
}

export function setupFakeIDB() {
  globalThis.IDBKeyRange = FakeIDBKeyRange;
  globalThis.indexedDB = new FakeIndexedDB();
  return globalThis.indexedDB;
}
