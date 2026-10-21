import { MESSAGE_TYPES } from '../shared/constants.js';
import { sendToSW, onSWMessage, requestFromSW } from './messaging.js';
import { logger } from './logger.js';

let _watchdogActive = false;
let _watchdogTimer = null;
let _isMarkedHealthy = false;

/**
 * Report to the Service Worker that the application has booted successfully and is healthy.
 *
 * @param {string} [version] - Optional version identifier
 * @returns {Promise<void>}
 */
export async function markHealthy(version = '') {
  _isMarkedHealthy = true;
  if (_watchdogTimer) {
    clearTimeout(_watchdogTimer);
    _watchdogTimer = null;
  }
  _watchdogActive = false;

  logger.log('[NLPWA] Application marked healthy.');
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('nlpwa:boot-healthy', { bubbles: true, detail: { version } }));
  }

  return sendToSW({
    type: MESSAGE_TYPES.REPORT_BOOT_HEALTH,
    version,
  });
}

/**
 * Report a boot failure or startup crash to the Service Worker.
 *
 * @param {Error|string} error - The error encountered during startup
 * @param {Object} [options]
 * @param {boolean} [options.rollback=true] - Whether the SW should execute an immediate rollback
 * @param {string} [options.version] - Current failing version
 * @returns {Promise<any>}
 */
export async function reportBootFailure(error, { rollback = true, version = '' } = {}) {
  const errorMessage = error?.message || String(error || 'Boot failure');
  logger.warn(`[NLPWA] Reporting boot failure: ${errorMessage}`);

  if (typeof document !== 'undefined') {
    document.dispatchEvent(
      new CustomEvent('nlpwa:boot-failure', {
        bubbles: true,
        detail: { error: errorMessage, rollback, version },
      })
    );
  }

  return sendToSW({
    type: MESSAGE_TYPES.REPORT_BOOT_FAILURE,
    error: errorMessage,
    rollback,
    version,
  });
}

/**
 * Manually trigger a rollback to the fallback version.
 *
 * @param {string} [reason] - Reason for rollback
 * @returns {Promise<{ success: boolean, version?: string, rolledBackFrom?: string, error?: string }>}
 */
export async function rollback(reason = 'Manual rollback requested by client') {
  return requestFromSW(
    MESSAGE_TYPES.TRIGGER_ROLLBACK,
    { reason },
    MESSAGE_TYPES.TRIGGER_ROLLBACK,
    5000
  );
}

/**
 * Query the list of blocked/blacklisted version strings from the Service Worker.
 *
 * @returns {Promise<string[]>}
 */
export async function getBlockedVersions() {
  try {
    const res = await requestFromSW(
      MESSAGE_TYPES.GET_BLOCKED_VERSIONS,
      {},
      MESSAGE_TYPES.BLOCKED_VERSIONS_INFO,
      5000
    );
    return res?.versions || [];
  } catch {
    return [];
  }
}

/**
 * Subscribe to rollback events broadcast by the Service Worker.
 *
 * @param {Function} handler - Called with rollback payload ({ version, rolledBackFrom, reason })
 * @returns {Function} Unsubscribe function
 */
export function onRollbackApplied(handler) {
  return onSWMessage(MESSAGE_TYPES.ROLLBACK_APPLIED, (data) => {
    if (typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('nlpwa:rollback-applied', {
          bubbles: true,
          detail: data,
        })
      );
    }
    handler(data);
  });
}

/**
 * Reset internal watchdog state (primarily for tests).
 */
export function resetWatchdogState() {
  if (_watchdogTimer) {
    clearTimeout(_watchdogTimer);
    _watchdogTimer = null;
  }
  _watchdogActive = false;
  _isMarkedHealthy = false;
}

/**
 * Check whether an error originated from first-party app code rather than
 * a browser extension (Chrome/Firefox/Safari extension) or external cross-origin script (GTM, ads, Sentry).
 *
 * @param {any} eventOrError
 * @returns {boolean}
 */
export function isFirstPartyError(eventOrError) {
  if (!eventOrError) return false;

  const filename = eventOrError.filename || eventOrError.fileName || '';
  if (filename) {
    if (
      filename.startsWith('chrome-extension://') ||
      filename.startsWith('moz-extension://') ||
      filename.startsWith('safari-web-extension://') ||
      filename.startsWith('extension://')
    ) {
      return false;
    }
    try {
      if (typeof window !== 'undefined' && window.location?.origin) {
        const fileOrigin = new URL(filename, window.location.href).origin;
        if (fileOrigin !== window.location.origin) {
          return false;
        }
      }
    } catch {}
  }

  const stack = eventOrError.error?.stack || eventOrError.stack || '';
  if (stack) {
    if (
      stack.includes('chrome-extension://') ||
      stack.includes('moz-extension://') ||
      stack.includes('safari-web-extension://') ||
      stack.includes('extension://')
    ) {
      return false;
    }
  }

  const message = eventOrError.message || eventOrError.error?.message || String(eventOrError);
  if (message === 'Script error.' && !filename) {
    return false;
  }

  return true;
}

/**
 * Start a client startup watchdog that automatically detects boot crashes
 * or hangs, and rolls back to the previous stable cache.
 *
 * Call `markHealthy()` once your app has initialized to disarm the watchdog.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=5000] - Max time allowed before declaring boot failure
 * @param {'rollback' | 'warn'} [options.onCrash='rollback'] - Action on startup crash
 * @param {boolean} [options.autoReload=true] - Automatically reload window if rolled back
 * @returns {Function} Function to cancel watchdog manually
 */
export function watchdog({
  timeoutMs = 5000,
  onCrash = 'rollback',
  autoReload = true,
} = {}) {
  if (_watchdogActive) return () => {};
  _watchdogActive = true;
  _isMarkedHealthy = false;

  // Listen for rollback event to reload window if autoReload is true
  let unsubscribeRollback = null;
  if (autoReload && typeof window !== 'undefined') {
    unsubscribeRollback = onRollbackApplied((data) => {
      logger.warn(`[NLPWA] Rollback applied (reverted to v${data.version}). Reloading page...`);
      window.location.reload();
    });
  }

  const triggerFailure = (err) => {
    if (!_watchdogActive || _isMarkedHealthy) return;
    _watchdogActive = false;
    cleanupListeners();
    reportBootFailure(err, { rollback: onCrash === 'rollback' });
  };

  const errorHandler = (event) => {
    if (!isFirstPartyError(event)) {
      logger.debug?.('[NLPWA] Ignoring third-party/extension error during boot:', event.message || event);
      return;
    }
    triggerFailure(event.error || event.message || 'Unhandled window error during boot');
  };

  const rejectionHandler = (event) => {
    if (!isFirstPartyError(event.reason)) {
      logger.debug?.('[NLPWA] Ignoring third-party/extension rejection during boot:', event.reason);
      return;
    }
    triggerFailure(event.reason || 'Unhandled promise rejection during boot');
  };

  const cleanupListeners = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
    }
    if (_watchdogTimer) {
      clearTimeout(_watchdogTimer);
      _watchdogTimer = null;
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);
  }

  _watchdogTimer = setTimeout(() => {
    if (_watchdogActive && !_isMarkedHealthy) {
      logger.warn(`[NLPWA] Boot watchdog timed out after ${timeoutMs}ms without markHealthy().`);
      triggerFailure(new Error(`Boot watchdog timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);

  return () => {
    _watchdogActive = false;
    cleanupListeners();
    if (unsubscribeRollback) unsubscribeRollback();
  };
}
