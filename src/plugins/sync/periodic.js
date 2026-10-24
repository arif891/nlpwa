/**
 * Periodic Background Sync Constants & Helpers
 * Part of NLPWA Sync Plugin (progressive enhancement for scheduled background tasks)
 */
export const PERIODIC_SYNC_CONSTANTS = {
  MIN_INTERVAL_MS: 12 * 60 * 60 * 1000, // 12 hours minimum recommended by browsers
  DEFAULT_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
  FALLBACK_CHECK_INTERVAL_MS: 60 * 1000, // 1 minute active tab check interval
  STORAGE_KEY_PREFIX: 'nlpwa:periodic-sync:last-run:',
};

export const PERIODIC_SYNC_STRATEGIES = {
  NATIVE: 'native',
  FALLBACK: 'fallback',
};

// Internal registry of active fallback timers and listeners in client window
const activeFallbacks = new Map();

/**
 * Check if the browser natively supports the Periodic Background Sync API.
 *
 * @returns {boolean}
 */
export function isPeriodicSyncSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return (
    'serviceWorker' in navigator &&
    typeof ServiceWorkerRegistration !== 'undefined' &&
    'periodicSync' in ServiceWorkerRegistration.prototype
  );
}

/**
 * Query the browser permission status for periodic-background-sync.
 *
 * @returns {Promise<'granted'|'denied'|'prompt'|'unsupported'>}
 */
export async function getPeriodicSyncPermission() {
  if (!isPeriodicSyncSupported() || typeof navigator.permissions?.query !== 'function') {
    return 'unsupported';
  }

  try {
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

/**
 * Resolve the active Service Worker registration.
 *
 * @param {ServiceWorkerRegistration} [registration]
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
async function resolveRegistration(registration) {
  if (registration) return registration;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Retrieve the timestamp of the last executed sync for a tag.
 *
 * @param {string} tag
 * @returns {number}
 */
function getLastRun(tag) {
  if (typeof localStorage !== 'undefined') {
    try {
      const val = localStorage.getItem(`${PERIODIC_SYNC_CONSTANTS.STORAGE_KEY_PREFIX}${tag}`);
      return val ? parseInt(val, 10) : 0;
    } catch (err) {
      console.debug?.('[NLPWA] localStorage access blocked in getLastRun:', err?.message || err);
    }
  }
  return 0;
}

/**
 * Save the timestamp of the last executed sync for a tag.
 *
 * @param {string} tag
 * @param {number} timestamp
 */
function setLastRun(tag, timestamp) {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`${PERIODIC_SYNC_CONSTANTS.STORAGE_KEY_PREFIX}${tag}`, String(timestamp));
    } catch (err) {
      console.debug?.('[NLPWA] localStorage access blocked in setLastRun:', err?.message || err);
    }
  }
}

/**
 * Register a periodic background sync tag with automatic progressive enhancement.
 *
 * If native periodicSync is supported and permitted (Chromium installed PWA), it registers
 * with the browser's background scheduler. If unsupported (e.g. Safari, Firefox, uninstalled PWA),
 * it seamlessly degrades to in-tab focus/visibility and interval scheduling.
 *
 * @param {string} tag Identifier tag for this periodic sync task
 * @param {Object} [options]
 * @param {number} [options.minInterval] Minimum interval in milliseconds (default: 24h)
 * @param {() => Promise<void>|void} [options.onSync] Fallback callback executed when sync triggers
 * @param {boolean} [options.allowFallback=true] Whether to fall back to in-tab scheduler when native is unavailable
 * @param {ServiceWorkerRegistration} [options.registration]
 * @returns {Promise<{ registered: boolean, strategy: 'native'|'fallback'|'none', tag: string, minInterval: number, error?: Error }>}
 */
export async function registerPeriodicSync(tag, options = {}) {
  if (typeof tag !== 'string' || !tag.trim()) {
    throw new TypeError('[NLPWA/sync] tag must be a non-empty string.');
  }

  const minInterval = Math.max(1000, Number(options.minInterval || PERIODIC_SYNC_CONSTANTS.DEFAULT_INTERVAL_MS));
  const allowFallback = options.allowFallback ?? true;
  const onSync = typeof options.onSync === 'function' ? options.onSync : null;

  // 1. Try Native Periodic Background Sync
  if (isPeriodicSyncSupported()) {
    try {
      const reg = await resolveRegistration(options.registration);
      if (reg && 'periodicSync' in reg) {
        await reg.periodicSync.register(tag, { minInterval });
        return {
          registered: true,
          strategy: PERIODIC_SYNC_STRATEGIES.NATIVE,
          tag,
          minInterval,
        };
      }
    } catch (err) {
      // Native periodicSync may reject if PWA is not installed or has low engagement
    }
  }

  // 2. Progressive Enhancement Fallback
  if (!allowFallback) {
    return {
      registered: false,
      strategy: 'none',
      tag,
      minInterval,
    };
  }

  unregisterFallback(tag);

  let isRunning = false;
  const triggerCheck = async () => {
    if (isRunning) return;
    const now = Date.now();
    const lastRun = getLastRun(tag);
    if (now - lastRun >= minInterval) {
      isRunning = true;
      try {
        setLastRun(tag, now);
        if (onSync) {
          await onSync();
        }
      } catch (err) {
        console.warn?.(`[NLPWA/sync] periodic fallback execution for "${tag}" failed:`, err?.message || err);
      } finally {
        isRunning = false;
      }
    }
  };

  triggerCheck();

  const onFocus = () => triggerCheck();
  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      triggerCheck();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const checkIntervalMs = Math.min(minInterval, PERIODIC_SYNC_CONSTANTS.FALLBACK_CHECK_INTERVAL_MS);
  const timerId = typeof setInterval === 'function' ? setInterval(triggerCheck, checkIntervalMs) : null;

  activeFallbacks.set(tag, {
    minInterval,
    onFocus,
    onVisibilityChange,
    timerId,
  });

  return {
    registered: true,
    strategy: PERIODIC_SYNC_STRATEGIES.FALLBACK,
    tag,
    minInterval,
  };
}

function unregisterFallback(tag) {
  const existing = activeFallbacks.get(tag);
  if (!existing) return;

  if (typeof window !== 'undefined' && existing.onFocus) {
    window.removeEventListener('focus', existing.onFocus);
  }
  if (typeof document !== 'undefined' && existing.onVisibilityChange) {
    document.removeEventListener('visibilitychange', existing.onVisibilityChange);
  }
  if (existing.timerId) {
    clearInterval(existing.timerId);
  }
  activeFallbacks.delete(tag);
}

/**
 * Unregister a periodic background sync tag.
 *
 * @param {string} tag
 * @param {Object} [options]
 * @param {ServiceWorkerRegistration} [options.registration]
 * @returns {Promise<boolean>}
 */
export async function unregisterPeriodicSync(tag, options = {}) {
  let nativeSuccess = false;

  if (isPeriodicSyncSupported()) {
    try {
      const reg = await resolveRegistration(options.registration);
      if (reg && 'periodicSync' in reg) {
        await reg.periodicSync.unregister(tag);
        nativeSuccess = true;
      }
    } catch (err) {
      console.debug?.('[NLPWA] Failed to unregister native periodicSync tag:', tag, err?.message || err);
    }
  }

  const hadFallback = activeFallbacks.has(tag);
  unregisterFallback(tag);

  return nativeSuccess || hadFallback;
}

/**
 * Retrieve all registered periodic sync tags (both native and active fallback).
 *
 * @param {Object} [options]
 * @param {ServiceWorkerRegistration} [options.registration]
 * @returns {Promise<string[]>}
 */
export async function getPeriodicSyncTags(options = {}) {
  const tags = new Set(activeFallbacks.keys());

  if (isPeriodicSyncSupported()) {
    try {
      const reg = await resolveRegistration(options.registration);
      if (reg && 'periodicSync' in reg && typeof reg.periodicSync.getTags === 'function') {
        const nativeTags = await reg.periodicSync.getTags();
        for (const t of nativeTags) {
          tags.add(t);
        }
      }
    } catch (err) {
      console.debug?.('[NLPWA] Failed to query native periodicSync tags:', err?.message || err);
    }
  }

  return Array.from(tags);
}

/**
 * Periodic Sync Client Helper Class
 */
export class PeriodicSyncClient {
  isSupported() {
    return isPeriodicSyncSupported();
  }

  async getPermission() {
    return await getPeriodicSyncPermission();
  }

  async register(tag, options = {}) {
    return await registerPeriodicSync(tag, options);
  }

  async unregister(tag, options = {}) {
    return await unregisterPeriodicSync(tag, options);
  }

  async getTags(options = {}) {
    return await getPeriodicSyncTags(options);
  }
}

export const periodicSyncClient = new PeriodicSyncClient();

/**
 * Service Worker Plugin for Periodic Background Sync tasks.
 */
export class PeriodicSyncPlugin {
  /**
   * @param {Object} [options]
   * @param {Record<string, (event: Event) => Promise<any>|void>} [options.tags] Map of tag names to handlers
   * @param {(event: Event) => Promise<any>|void} [options.onSync] Fallback handler for all periodic sync tags
   */
  constructor(options = {}) {
    this.handlers = new Map();
    if (options.tags && typeof options.tags === 'object') {
      for (const [tag, fn] of Object.entries(options.tags)) {
        if (typeof fn === 'function') {
          this.handlers.set(tag, fn);
        }
      }
    }
    this.customOnSync = typeof options.onSync === 'function' ? options.onSync : null;
  }

  /**
   * Register a tag handler in the Service Worker.
   *
   * @param {string} tag
   * @param {(event: Event) => Promise<any>|void} handler
   * @returns {this}
   */
  on(tag, handler) {
    if (typeof tag === 'string' && typeof handler === 'function') {
      this.handlers.set(tag, handler);
    }
    return this;
  }

  /**
   * Invoked by Service Worker engine on 'periodicsync' event.
   *
   * @param {Event} event
   */
  onPeriodicSync(event) {
    const tag = event?.tag;
    const handler = tag ? this.handlers.get(tag) : null;

    if (handler) {
      try {
        const res = handler(event);
        if (res && typeof res.then === 'function') {
          event.waitUntil(res);
        }
      } catch (err) {
        console.warn?.(`[NLPWA/sync] Periodic handler for "${tag}" failed:`, err?.message || err);
      }
    } else if (this.customOnSync) {
      try {
        const res = this.customOnSync(event);
        if (res && typeof res.then === 'function') {
          event.waitUntil(res);
        }
      } catch (err) {
        console.warn?.('[NLPWA/sync] Periodic customOnSync failed:', err?.message || err);
      }
    }
  }
}
