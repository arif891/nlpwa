import { readMeta, writeMeta, deleteMeta } from './store.js';
import { compare } from '../../../shared/version.js';

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
          _clientPins.set(clientId, { cache: val, version: null, pinnedAt: 0 });
        } else if (val && typeof val === 'object' && typeof val.cache === 'string') {
          _clientPins.set(clientId, {
            cache: val.cache,
            version: val.version || null,
            pinnedAt: val.pinnedAt || 0,
          });
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

export function pinClient(clientId, cacheName, version = null, pinnedAt = Date.now()) {
  if (!clientId || !cacheName) return Promise.resolve();
  _clientPins.set(clientId, { cache: cacheName, version: version || null, pinnedAt });
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

export const PIN_GRACE_PERIOD_MS = 30000;

export async function pruneClientPins(graceMs = PIN_GRACE_PERIOD_MS) {
  const clientsObj = typeof self !== 'undefined' && self.clients ? self.clients : null;
  if (!clientsObj || typeof clientsObj.matchAll !== 'function') {
    return;
  }
  try {
    const clients = await clientsObj.matchAll({ includeUncontrolled: true, type: 'window' });
    const liveIds = new Set(clients.map((c) => c.id));
    const now = Date.now();
    let changed = false;
    for (const [id, pin] of _clientPins.entries()) {
      if (!liveIds.has(id)) {
        // Protect recently created pins from being prematurely pruned before the tab appears in clients.matchAll
        const pinnedAt = typeof pin === 'object' ? (pin?.pinnedAt || 0) : 0;
        if (now - pinnedAt < graceMs) {
          continue;
        }
        _clientPins.delete(id);
        changed = true;
      }
    }
    if (changed) {
      await flushClientPins();
    }
  } catch {}
}

/**
 * Remove pins for any clients that are pinned to a version below minVersion.
 *
 * @param {string} minVersion
 * @returns {Promise<Array<string>>} List of unpinned client IDs
 */
export async function unpinClientsBelowVersion(minVersion) {
  if (!minVersion) return [];
  const unpinned = [];
  for (const [id, pin] of _clientPins.entries()) {
    const v = typeof pin === 'object' ? (pin?.version || null) : null;
    if (v && compare(v, minVersion) < 0) {
      _clientPins.delete(id);
      unpinned.push(id);
    }
  }
  if (unpinned.length > 0) {
    await flushClientPins();
  }
  return unpinned;
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
