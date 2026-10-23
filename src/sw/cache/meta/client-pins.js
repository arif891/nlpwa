import { readMeta, writeMeta, deleteMeta } from './store.js';
import { compare } from '../../../shared/version.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('NLPWA');

const PINS_KEY = '/_nlpwa/client-pins.json';

export const PIN_STATES = {
  BOOTING:  'BOOTING',
  PINNED:   'PINNED',
  ORPHANED: 'ORPHANED',
  EXPIRED:  'EXPIRED',
};
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
          _clientPins.set(clientId, { cache: val, version: null, pinnedAt: 0, lastSeenAt: Date.now() });
        } else if (val && typeof val === 'object' && typeof val.cache === 'string') {
          _clientPins.set(clientId, {
            cache: val.cache,
            version: val.version || null,
            pinnedAt: val.pinnedAt || 0,
            lastSeenAt: val.lastSeenAt || val.pinnedAt || Date.now(),
          });
        }
      }
    }
  } catch (err) {
    logger.debug('[NLPWA] Failed to initialize client pins from storage:', err?.message || err);
  }
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
    } catch (err) {
      logger.debug('[NLPWA] Failed to flush client pins to storage:', err?.message || err);
    }
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
  _clientPins.set(clientId, {
    cache: cacheName,
    version: version || null,
    pinnedAt,
    lastSeenAt: pinnedAt,
  });
  return flushClientPins();
}

export function touchClientPin(clientId) {
  if (!clientId) return;
  const pin = _clientPins.get(clientId);
  if (pin && typeof pin === 'object') {
    pin.lastSeenAt = Date.now();
    if (!_savePinsTimeout) {
      _savePinsTimeout = setTimeout(() => {
        _savePinsTimeout = null;
        flushClientPins();
      }, 5000);
    }
  }
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

/**
 * Retrieve formalized pin lifecycle state and details for a client.
 *
 * @param {string} clientId
 * @param {{ activeCache?: string, graceMs?: number }} [options]
 * @returns {{
 *   clientId: string|null,
 *   state: 'BOOTING' | 'PINNED' | 'ORPHANED' | 'EXPIRED',
 *   version: string|null,
 *   cache: string|null,
 *   pinnedAt: number|null,
 *   lastSeenAt: number|null,
 *   graceRemainingMs: number|null
 * }}
 */
export function getClientPinStatus(clientId, { activeCache = null, graceMs = PIN_GRACE_PERIOD_MS } = {}) {
  if (!clientId) {
    return {
      clientId: null,
      state: PIN_STATES.BOOTING,
      version: null,
      cache: null,
      pinnedAt: null,
      lastSeenAt: null,
      graceRemainingMs: null,
    };
  }

  const pin = _clientPins.get(clientId);
  if (!pin) {
    return {
      clientId,
      state: PIN_STATES.EXPIRED,
      version: null,
      cache: null,
      pinnedAt: null,
      lastSeenAt: null,
      graceRemainingMs: null,
    };
  }

  const cacheName = typeof pin === 'string' ? pin : pin.cache;
  const version = typeof pin === 'object' ? (pin.version || null) : null;
  const pinnedAt = typeof pin === 'object' ? (pin.pinnedAt || 0) : 0;
  const lastSeenAt = typeof pin === 'object' ? (pin.lastSeenAt || pinnedAt) : 0;

  let state = PIN_STATES.PINNED;
  let graceRemainingMs = null;

  if (activeCache && cacheName !== activeCache) {
    state = PIN_STATES.ORPHANED;
    const now = Date.now();
    const elapsed = now - lastSeenAt;
    graceRemainingMs = Math.max(0, graceMs - elapsed);
    if (graceRemainingMs === 0) {
      state = PIN_STATES.EXPIRED;
    }
  }

  return {
    clientId,
    state,
    version,
    cache: cacheName,
    pinnedAt,
    lastSeenAt,
    graceRemainingMs,
  };
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
        // Protect recently created or recently active pins from being prematurely pruned
        // if a backgrounded tab or frozen tab does not appear in clients.matchAll
        const lastSeen = typeof pin === 'object' ? (pin?.lastSeenAt || pin?.pinnedAt || 0) : 0;
        if (now - lastSeen < graceMs) {
          continue;
        }
        _clientPins.delete(id);
        changed = true;
      } else if (typeof pin === 'object') {
        pin.lastSeenAt = now;
      }
    }
    if (changed) {
      await flushClientPins();
    }
  } catch (err) {
    logger.debug('[NLPWA] Failed to prune client pins:', err?.message || err);
  }
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
