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

export { isUserEditing };

/**
 * Register the NLPWA Service Worker and set up update handling.
 *
 * @param {string} [swUrl='/sw.js'] path to the bundled sw.js
 * @param {Object} [options={}]
 * @returns {Promise<{ registration: ServiceWorkerRegistration, unsubscribe: Function }|null>}
 */
export async function register(swUrl = '/sw.js', options = {}) {
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

  let registration;
  try {
    registration = await navigator.serviceWorker.register(swUrl, regOptions);
    logger.log('[NLPWA] SW registered:', registration.scope);
  } catch (err) {
    logger.error('[NLPWA] SW registration failed:', err);
    return null;
  }

  // ── Update-ready handler ───────────────────────────────────────────────────
  const unsubscribeUpdate = onUpdateReady((data) => {
    if (typeof options.onUpdateReady === 'function') {
      options.onUpdateReady(data);
    }
    if (options.autoReload) {
      const customDefer = typeof options.shouldDeferReload === 'function'
        && Boolean(options.shouldDeferReload({ version: data?.version, reason: 'ready' }));
      const editing = isUserEditing();
      const shouldDefer = customDefer || editing;

      if (!shouldDefer) {
        applyUpdate();
      } else {
        const reason = customDefer ? 'deferred' : 'editing';
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
      const customDefer = typeof options.shouldDeferReload === 'function'
        && Boolean(options.shouldDeferReload({ version: data?.version, reason: 'applied' }));
      const editing = isUserEditing();
      const shouldDefer = customDefer || editing;

      if (!shouldDefer) {
        window.location.reload();
      } else {
        const reason = customDefer ? 'deferred' : 'editing';
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
    if (intervalTimer) clearInterval(intervalTimer);
    if (cleanupFocus) cleanupFocus();
    if (initialCheckControllerListener) {
      navigator.serviceWorker.removeEventListener?.('controllerchange', initialCheckControllerListener);
    }
  };

  return { registration, unsubscribe };
}

/**
 * Unregister the NLPWA Service Worker.
 *
 * @param {string} [scope] Optional scope to target a specific registration
 * @returns {Promise<boolean>} Resolves to true if unregistration succeeded
 */
export async function unregister(scope) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const registration = scope
      ? await navigator.serviceWorker.getRegistration(scope)
      : await navigator.serviceWorker.getRegistration();
    if (registration) {
      return await registration.unregister();
    }
    return false;
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
