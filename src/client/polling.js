/**
 * Set up focus-triggered update checking on visibility change.
 *
 * @param {Object} params
 * @returns {Function|null} Cleanup listener
 */
export function setupFocusPolling({ options, onCheck }) {
  const focusCheck = options.checkOnFocus !== false;
  if (!focusCheck || typeof document === 'undefined') return null;

  const throttleMs = options.focusThrottleMs ?? 60 * 60 * 1000; // 1 hour default
  let lastCheckAt = 0;

  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastCheckAt >= throttleMs) {
      lastCheckAt = now;
      onCheck();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Set up client-side periodic polling interval for active tabs.
 *
 * @param {Object} params
 * @returns {number|null} interval timer ID
 */
export function setupIntervalPolling({ options, onCheck }) {
  const pollIntervalMs = options.pollIntervalMs ?? 60 * 60 * 1000; // 1 hour default
  if (pollIntervalMs <= 0) return null;

  return setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      onCheck();
    }
  }, pollIntervalMs);
}

/**
 * Register Periodic Background Sync if supported and requested.
 *
 * @param {Object} params
 */
export function setupPeriodicSync({ registration, options, logger }) {
  const enablePeriodicSync = options.periodicSync !== false;
  const pollIntervalMs = options.pollIntervalMs ?? 60 * 60 * 1000;

  if (enablePeriodicSync && 'periodicSync' in registration) {
    try {
      if (pollIntervalMs < 86400000) {
        logger.warn('[NLPWA] Periodic Background Sync minInterval is set below 24h. Most browsers enforce a minimum interval of 12-24 hours for periodicSync.');
      }
      registration.periodicSync.register('nlpwa-update-check', {
        minInterval: pollIntervalMs,
      }).catch(() => {});
    } catch {
      // Periodic sync permission is granted by browser only for installed PWAs; ignore failure
    }
  }
}

/**
 * Request persistent storage if requested and supported.
 * By default, defers the prompt to 'appinstalled' or explicit user gesture rather than on initial page load.
 *
 * @param {Object} params
 */
export function setupPersistentStorage({ options, logger }) {
  if (!options.persistentStorage || typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return;
  }

  const requestPersist = () => {
    navigator.storage.persist().then((persisted) => {
      if (persisted) {
        logger.log('[NLPWA] Storage is persistent; browser will not evict cached resources under storage pressure.');
      } else {
        logger.log('[NLPWA] Storage is best-effort; persistent storage permission was not granted.');
      }
    }).catch(() => {});
  };

  // If set to 'on-install', defer until app installation event
  if (options.persistentStorage === 'on-install') {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('appinstalled', () => {
        logger.log('[NLPWA] App installed. Requesting persistent storage.');
        requestPersist();
      }, { once: true });
    }
    return;
  }

  requestPersist();
}
