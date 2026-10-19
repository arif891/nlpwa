import { readMeta, writeMeta, deleteMeta } from './store.js';

const PINS_KEY = '/_nlpwa/client-pins.json';
const _clientPins = new Map();
let _pinsLoaded = false;
let _savePinsTimeout = null;

export async function initClientPins() {
  if (_pinsLoaded) return;
  try {
    const stored = await readMeta(PINS_KEY);
    if (stored && typeof stored === 'object') {
      for (const [clientId, val] of Object.entries(stored)) {
        if (typeof val === 'string') {
          _clientPins.set(clientId, { cache: val, version: null });
        } else if (val && typeof val === 'object' && typeof val.cache === 'string') {
          _clientPins.set(clientId, { cache: val.cache, version: val.version || null });
        }
      }
    }
  } catch {}
  _pinsLoaded = true;
}

let _pendingWrite = null;
let _needsWrite = false;

export async function flushClientPins() {
  if (_savePinsTimeout) {
    clearTimeout(_savePinsTimeout);
    _savePinsTimeout = null;
  }

  if (_pendingWrite) {
    _needsWrite = true;
    return _pendingWrite;
  }

  const doWrite = async () => {
    try {
      const obj = Object.fromEntries(_clientPins);
      await writeMeta(PINS_KEY, obj);
    } catch {}
    if (_needsWrite) {
      _needsWrite = false;
      return doWrite();
    }
  };

  _pendingWrite = doWrite().finally(() => {
    _pendingWrite = null;
  });

  return _pendingWrite;
}

export function pinClient(clientId, cacheName, version = null) {
  if (!clientId || !cacheName) return Promise.resolve();
  _clientPins.set(clientId, { cache: cacheName, version: version || null });
  return flushClientPins();
}

export function unpinClient(clientId) {
  if (!clientId) return Promise.resolve();
  if (_clientPins.delete(clientId)) {
    return flushClientPins();
  }
  return Promise.resolve();
}

export function getClientPinnedCache(clientId) {
  if (!clientId) return null;
  const pin = _clientPins.get(clientId);
  return typeof pin === 'string' ? pin : (pin?.cache || null);
}

export function getClientPinnedVersion(clientId) {
  if (!clientId) return null;
  const pin = _clientPins.get(clientId);
  return typeof pin === 'object' ? (pin?.version || null) : null;
}

export function getAllPinnedCaches() {
  const caches = [];
  for (const pin of _clientPins.values()) {
    const c = typeof pin === 'string' ? pin : pin?.cache;
    if (c) caches.push(c);
  }
  return Array.from(new Set(caches));
}

export async function pruneClientPins() {
  const clientsObj = typeof self !== 'undefined' && self.clients ? self.clients : null;
  if (!clientsObj || typeof clientsObj.matchAll !== 'function') {
    return;
  }
  try {
    const clients = await clientsObj.matchAll({ includeUncontrolled: true, type: 'window' });
    const liveIds = new Set(clients.map((c) => c.id));
    let changed = false;
    for (const id of _clientPins.keys()) {
      if (!liveIds.has(id)) {
        _clientPins.delete(id);
        changed = true;
      }
    }
    if (changed) {
      await flushClientPins();
    }
  } catch {}
}

export function resetClientPinsMemo() {
  _clientPins.clear();
  _pinsLoaded = false;
  if (_savePinsTimeout) {
    clearTimeout(_savePinsTimeout);
    _savePinsTimeout = null;
  }
  _pendingWrite = null;
  _needsWrite = false;
}

export { PINS_KEY };
