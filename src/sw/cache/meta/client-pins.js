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
      for (const [clientId, cacheName] of Object.entries(stored)) {
        if (typeof clientId === 'string' && typeof cacheName === 'string') {
          _clientPins.set(clientId, cacheName);
        }
      }
    }
  } catch {}
  _pinsLoaded = true;
}

export function pinClient(clientId, cacheName) {
  if (!clientId || !cacheName) return;
  _clientPins.set(clientId, cacheName);
  _saveClientPins();
}

export function unpinClient(clientId) {
  if (!clientId) return;
  if (_clientPins.delete(clientId)) {
    _saveClientPins();
  }
}

export function getClientPinnedCache(clientId) {
  if (!clientId) return null;
  return _clientPins.get(clientId) || null;
}

export function getAllPinnedCaches() {
  return Array.from(new Set(_clientPins.values()));
}

function _saveClientPins() {
  if (_savePinsTimeout) return;
  _savePinsTimeout = setTimeout(async () => {
    _savePinsTimeout = null;
    try {
      const obj = Object.fromEntries(_clientPins);
      await writeMeta(PINS_KEY, obj);
    } catch {}
  }, 100);
}

async function _flushClientPins() {
  if (_savePinsTimeout) {
    clearTimeout(_savePinsTimeout);
    _savePinsTimeout = null;
  }
  try {
    const obj = Object.fromEntries(_clientPins);
    await writeMeta(PINS_KEY, obj);
  } catch {}
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
      await _flushClientPins();
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
}

export { PINS_KEY };
