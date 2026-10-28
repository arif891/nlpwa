import { onUpdateReady, onNoUpdate, onUpdateFailed, applyUpdate } from './update-ui.js';
import { requestUpdateCheck, onSWMessage } from './messaging.js';
import { MESSAGE_TYPES } from '../shared/constants.js';
import { logger, setClientLogLevel } from './logger.js';
import { isUserEditing } from './form-guard.js';
import {
  setupFocusPolling,
  setupIntervalPolling,
  setupPeriodicSync,
  setupPersistentStorage,
} from './polling.js';
import { isDevFlag } from './dev-flags.js';

export { isUserEditing };

let _activeUnsubscribe = null;
let _isRegisteredOrRegistering = false;
let _inFlightRegisterPromise = null;

/**
 * Resolve the default service worker URL.
 * Prefers explicit configuration via `data-sw` attribute or `window.NLPWA_SW_URL`,
 * falling back to root `/sw.js` without fragile directory guessing.
 *
 * @param {HTMLScriptElement} [script]
 * @returns {string}
 */
export function resolveDefaultSwUrl(script) {
  const customSw = script?.getAttribute?.('data-sw');
  if (customSw) {
    return customSw;
  }
  if (typeof window !== 'undefined' && window.NLPWA_SW_URL) {
    return window.NLPWA_SW_URL;
  }
  return '/sw.js';
}

/**
 * Register the NLPWA Service Worker and set up update handling.
 *
 * @param {string} [swUrl='/sw.js'] path to the bundled sw.js
 * @param {Object} [options={}]
 * @returns {Promise<{ registration: ServiceWorkerRegistration, unsubscribe: Function }|null>}
 */
export async function register(swUrl = '/sw.js', options = {}) {
  // If auto-registration is attempted but a registration is already active or in progress, do nothing
  if (options._auto && _isRegisteredOrRegistering) {
    return null;
  }

  // If another register() call is in progress, wait for it to complete
  // so any created listeners can be cleaned up cleanly without leaking
  if (_inFlightRegisterPromise) {
    try {
      await _inFlightRegisterPromise;
    } catch (err) {
      logger.debug('[NLPWA] In-flight register promise rejected:', err?.message || err);
    }
    if (options._auto && _isRegisteredOrRegistering) {
      return null;
    }
  }

  const executeRegister = async () => {
    if (
      isDevFlag(options.dev) ||
      (typeof window !== 'undefined' && (
        isDevFlag(window.NLPWA_DEV) ||
        isDevFlag(window.NLPWA_CONFIG?.dev)
      ))
    ) {
      logger.info('[NLPWA] Dev mode: Service Worker registration bypassed.');
      await unregister(options.scope);
      return null;
    }

    _isRegisteredOrRegistering = true;

    if (_activeUnsubscribe) {
      try {
        _activeUnsubscribe();
      } catch (err) {
        logger.debug('[NLPWA] Error running active unsubscribe:', err?.message || err);
      }
      _activeUnsubscribe = null;
    }

    if (options.logLevel) {
      setClientLogLevel(options.logLevel);
    }

    if (!('serviceWorker' in navigator)) {
      logger.warn('[NLPWA] Service Workers are not supported in this browser.');
      return null;
    }

    const regOptions = {};
    if (options.type) regOptions.type = options.type;
    if (options.scope) regOptions.scope = options.scope;
    if (options.updateViaCache) regOptions.updateViaCache = options.updateViaCache;

    const requestedScope = regOptions.scope || 'default';
    logger.log(`[NLPWA] Registering Service Worker: url='${swUrl}', scope='${requestedScope}'`);

    let registration;
    try {
      registration = await navigator.serviceWorker.register(swUrl, regOptions);
      logger.log(`[NLPWA] SW registered: url='${swUrl}', scope='${registration.scope}'`);
    } catch (err) {
      _isRegisteredOrRegistering = false;
      if (!options._silentFail) {
        logger.error(`[NLPWA] SW registration failed: url='${swUrl}', scope='${requestedScope}':`, err);
      }
      return null;
    }

    function checkReloadDeferral(version, reason) {
      const customDefer = typeof options.shouldDeferReload === 'function'
        && Boolean(options.shouldDeferReload({ version, reason }));
      const editing = isUserEditing();
      const shouldDefer = customDefer || editing;
      const deferReason = shouldDefer ? (customDefer ? 'deferred' : 'editing') : null;
      return { shouldDefer, reason: deferReason };
    }

    // ── Update-ready handler ───────────────────────────────────────────────────
    let lastReadyVersion = null;
    const unsubscribeUpdate = onUpdateReady((data) => {
      if (data?.version && data.version === lastReadyVersion && !data.force) {
        return;
      }
      lastReadyVersion = data?.version || null;

      if (typeof options.onUpdateReady === 'function') {
        options.onUpdateReady(data);
      }
      if (options.autoReload) {
        const { shouldDefer, reason } = checkReloadDeferral(data?.version, 'ready');

        if (!shouldDefer) {
          applyUpdate();
        } else {
          logger.warn(`[NLPWA] Auto-reload deferred (${reason}). Offering update prompt instead to protect unsaved edits.`);
          if (typeof options.onUpdatePrompt === 'function') {
            options.onUpdatePrompt({ ...data, reason });
          }
          document.dispatchEvent(
            new CustomEvent('nlpwa:update-prompt', {
              bubbles: true,
              detail: { version: data?.version, reason },
            })
          );
        }
      }
    });

    // ── Update-applied handler (cross-tab coordination) ────────────────────────
    let unsubscribeApplied = onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
      if (data?.applied === false) return;
      lastReadyVersion = null;

      document.dispatchEvent(
        new CustomEvent('nlpwa:update-applied', {
          bubbles: true,
          detail: { version: data?.version },
        })
      );
      if (typeof options.onUpdateApplied === 'function') {
        options.onUpdateApplied(data);
      }
      if (options.reloadOnUpdateApplied || options.autoReload) {
        const { shouldDefer, reason } = checkReloadDeferral(data?.version, 'applied');

        if (!shouldDefer) {
          window.location.reload();
        } else {
          logger.warn(`[NLPWA] Reload on update-applied deferred (${reason}). Offering update prompt instead to protect unsaved edits.`);
          if (typeof options.onUpdatePrompt === 'function') {
            options.onUpdatePrompt({ version: data?.version, updateApplied: true, reason });
          } else if (typeof options.onUpdateReady === 'function') {
            options.onUpdateReady({ version: data?.version, updateApplied: true, reason });
          }
          document.dispatchEvent(
            new CustomEvent('nlpwa:update-prompt', {
              bubbles: true,
              detail: { version: data?.version, updateApplied: true, reason },
            })
          );
        }
      }
    });

    // ── No-update handler ──────────────────────────────────────────────────────
    const unsubscribeNoUpdate = onNoUpdate((data) => {
      if (typeof options.onNoUpdate === 'function') {
        options.onNoUpdate(data);
      }
    });

    // ── Update-failed handler ──────────────────────────────────────────────────
    const unsubscribeUpdateFailed = onUpdateFailed((data) => {
      if (typeof options.onUpdateFailed === 'function') {
        options.onUpdateFailed(data);
      }
    });

    // ── Update-required handler (minVersion enforcement) ───────────────────────
    const unsubscribeUpdateRequired = onUpdateRequired((data) => {
      if (typeof options.onUpdateRequired === 'function') {
        options.onUpdateRequired(data);
      } else if (options.forceReloadOnRequired !== false) {
        let canReload = true;
        try {
          if (typeof sessionStorage !== 'undefined') {
            const key = 'nlpwa_req_reload';
            const record = JSON.parse(sessionStorage.getItem(key) || '{"count":0,"time":0}');
            const now = Date.now();
            if (now - (record.time || 0) < 10000) {
              record.count = (record.count || 0) + 1;
            } else {
              record.count = 1;
              record.time = now;
            }
            sessionStorage.setItem(key, JSON.stringify(record));
            if (record.count > 2) {
              canReload = false;
              logger.error(`[NLPWA] Multiple rapid reloads detected for minVersion (${data?.minVersion}). Reload loop blocked to protect user.`);
              if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
                document.dispatchEvent(new CustomEvent('nlpwa:update-required-blocked', { detail: data }));
              }
            }
          }
        } catch (err) {
          logger.debug('[NLPWA] Error reading reload throttle record from sessionStorage:', err?.message || err);
        }

        if (canReload) {
          logger.warn(`[NLPWA] Active or pinned version is below minimum supported version (${data?.minVersion}). Reloading application.`);
          if (typeof window !== 'undefined' && window.location?.reload) {
            window.location.reload();
          }
        }
      }
    });

    // ── Polling & background sync ─────────────────────────────────────────────
    const cleanupFocus = setupFocusPolling({
      options,
      onCheck: () => requestUpdateCheck().catch(() => {}),
    });

    const intervalTimer = setupIntervalPolling({
      options,
      onCheck: () => requestUpdateCheck().catch(() => {}),
    });

    setupPeriodicSync({ registration, options, logger });
    setupPersistentStorage({ options, logger });

    // ── Initial update check on registration ──────────────────────────────────
    const checkOnRegister = options.checkOnRegister !== false;
    let initialCheckControllerListener = null;
    if (checkOnRegister) {
      let initialCheckDone = false;
      const triggerInitialCheck = () => {
        if (initialCheckDone) return;
        initialCheckDone = true;
        if (initialCheckControllerListener) {
          navigator.serviceWorker.removeEventListener?.('controllerchange', initialCheckControllerListener);
          initialCheckControllerListener = null;
        }
        requestUpdateCheck().catch(() => {});
      };

      if (navigator.serviceWorker.controller) {
        triggerInitialCheck();
      } else {
        initialCheckControllerListener = triggerInitialCheck;
        navigator.serviceWorker.addEventListener?.('controllerchange', initialCheckControllerListener, { once: true });
        navigator.serviceWorker.ready?.then(triggerInitialCheck).catch(() => {});
      }
    }

    const unsubscribe = () => {
      unsubscribeUpdate();
      if (unsubscribeApplied) unsubscribeApplied();
      if (unsubscribeNoUpdate) unsubscribeNoUpdate();
      if (unsubscribeUpdateFailed) unsubscribeUpdateFailed();
      if (unsubscribeUpdateRequired) unsubscribeUpdateRequired();
      if (intervalTimer) clearInterval(intervalTimer);
      if (cleanupFocus) cleanupFocus();
      if (initialCheckControllerListener) {
        navigator.serviceWorker.removeEventListener?.('controllerchange', initialCheckControllerListener);
      }
      if (_activeUnsubscribe === unsubscribe) {
        _activeUnsubscribe = null;
        _isRegisteredOrRegistering = false;
      }
    };

    _activeUnsubscribe = unsubscribe;
    return { registration, unsubscribe };
  };

  _inFlightRegisterPromise = executeRegister();
  try {
    return await _inFlightRegisterPromise;
  } finally {
    _inFlightRegisterPromise = null;
  }
}

/**
 * Unregister the NLPWA Service Worker.
 *
 * @param {string} [scope] Optional scope to target a specific registration
 * @returns {Promise<boolean>} Resolves to true if unregistration succeeded
 */
export async function unregister(scope) {
  _isRegisteredOrRegistering = false;
  if (_inFlightRegisterPromise) {
    try {
      await _inFlightRegisterPromise;
    } catch (err) {
      logger.debug('[NLPWA] In-flight register promise rejected during unregister:', err?.message || err);
    }
  }
  if (_activeUnsubscribe) {
    try {
      _activeUnsubscribe();
    } catch (err) {
      logger.debug('[NLPWA] Error unsubscribing during unregister:', err?.message || err);
    }
    _activeUnsubscribe = null;
  }



  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    let unregSuccess = false;
    if (scope) {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      if (registration) {
        unregSuccess = await registration.unregister();
      }
    } else if (typeof navigator.serviceWorker.getRegistrations === 'function') {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        const ok = await reg.unregister();
        if (ok) unregSuccess = true;
      }
      if (!unregSuccess && typeof navigator.serviceWorker.getRegistration === 'function') {
        const single = await navigator.serviceWorker.getRegistration();
        if (single) {
          unregSuccess = await single.unregister();
        }
      }
    } else if (typeof navigator.serviceWorker.getRegistration === 'function') {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        unregSuccess = await registration.unregister();
      }
    }
    // Also purge caches in dev/unregistered state to ensure fresh assets
    if (typeof caches !== 'undefined') {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch (err) {
        logger.debug('[NLPWA] Cache cleanup error during unregister:', err?.message || err);
      }
    }
    return unregSuccess;
  } catch {
    return false;
  }
}

/**
 * Register a listener for when an update is committed/applied (in this tab or another tab).
 *
 * @param {(data: { version: string }) => void} callback
 * @returns {Function} unsubscribe function
 */
export function onUpdateApplied(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, (data) => {
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-applied', {
          bubbles: true,
          detail: { version: data?.version },
        })
      );
    }
    if (typeof callback === 'function') {
      callback({ version: data?.version });
    }
  });
}

/**
 * Register a listener for when an update is strictly required (active/pinned version < minVersion).
 *
 * @param {(data: { minVersion: string, activeVersion: string, targetVersion?: string, unpinnedClients?: string[] }) => void} callback
 * @returns {Function} unsubscribe function
 */
export function onUpdateRequired(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_REQUIRED, (data) => {
    if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
      document.dispatchEvent(
        new CustomEvent('nlpwa:update-required', {
          bubbles: true,
          detail: data,
        })
      );
    }
    if (typeof callback === 'function') {
      callback(data);
    }
  });
}

/**
 * Explicitly request persistent storage permission on a user gesture (e.g. settings toggle or button).
 *
 * @returns {Promise<boolean>} Whether persistent storage was granted
 */
export async function requestPersistentStorage() {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    return await navigator.storage.persist().catch(() => false);
  }
  return false;
}

