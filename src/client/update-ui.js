import { MESSAGE_TYPES } from '../shared/constants.js';
import { onSWMessage, sendToSW, requestFromSW } from './messaging.js';
import { logger } from './logger.js';
import { checkDirtyTabs } from './tabs.js';

/**
 * Register a handler to be called when the SW signals an update is ready.
 *
 * Also fires a `nlpwa:update-ready` CustomEvent on `document` so any part
 * of the app can listen without importing this module directly:
 *
 *   document.addEventListener('nlpwa:update-ready', (e) => {
 *     console.log('New version:', e.detail.version);
 *   });
 *
 * @param {(data: { version: string }) => void} [callback]
 * @returns {Function}  unsubscribe — call when the listening component unmounts
 */
function safeDispatchEvent(name, detail) {
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
    document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }
}

/**
 * Register a handler to be called when the SW signals an update is ready.
 *
 * Also fires a `nlpwa:update-ready` CustomEvent on `document` so any part
 * of the app can listen without importing this module directly:
 *
 *   document.addEventListener('nlpwa:update-ready', (e) => {
 *     console.log('New version:', e.detail.version);
 *   });
 *
 * @param {(data: { version: string }) => void} [callback]
 * @returns {Function}  unsubscribe — call when the listening component unmounts
 */
export function onUpdateReady(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_READY, (data) => {
    // Dispatch CustomEvent for decoupled listeners
    safeDispatchEvent('nlpwa:update-ready', { version: data.version });

    // Direct callback
    if (typeof callback === 'function') {
      callback({ version: data.version });
    }
  });
}

/**
 * Register a handler to be called when the SW signals that the app is already up to date.
 *
 * Also fires a `nlpwa:no-update` CustomEvent on `document` so any part
 * of the app can listen without importing this module directly:
 *
 *   document.addEventListener('nlpwa:no-update', (e) => {
 *     console.log('Already on latest version:', e.detail.version);
 *   });
 *
 * @param {(data: { version: string }) => void} [callback]
 * @returns {Function}  unsubscribe
 */
export function onNoUpdate(callback) {
  return onSWMessage(MESSAGE_TYPES.NO_UPDATE, (data) => {
    safeDispatchEvent('nlpwa:no-update', { version: data.version });

    if (typeof callback === 'function') {
      callback({ version: data.version });
    }
  });
}

/**
 * Register a handler to be called when the SW signals an update failed to stage or verify.
 *
 * Also fires a `nlpwa:update-failed` CustomEvent on `document` so any part
 * of the app can listen without importing this module directly:
 *
 *   document.addEventListener('nlpwa:update-failed', (e) => {
 *     console.warn('Update failed:', e.detail.error, e.detail.failed);
 *   });
 *
 * @param {(data: {
 *   version?: string,
 *   failed?: string[],
 *   failedDetails?: Record<string, string>,
 *   error?: string,
 *   retryCount?: number,
 *   nextRetryAt?: number|null,
 *   persistent?: boolean,
 *   hasHashMismatch?: boolean
 * }) => void} [callback]
 * @returns {Function}  unsubscribe — call when the listening component unmounts
 */
export function onUpdateFailed(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_FAILED, (data) => {
    const payload = {
      errorCode: data.errorCode,
      version: data.version,
      failed: data.failed ?? [],
      failedDetails: data.failedDetails ?? {},
      error: data.error,
      retryCount: data.retryCount,
      nextRetryAt: data.nextRetryAt,
      persistent: Boolean(data.persistent),
      hasHashMismatch: Boolean(data.hasHashMismatch),
      quotaExceeded: Boolean(data.quotaExceeded),
    };

    safeDispatchEvent('nlpwa:update-failed', payload);

    if (typeof callback === 'function') {
      callback(payload);
    }
  });
}

/**
 * Switch to the staged update, then reload the page.
 *
 * The SW builds updates in the background and only makes them live on a page
 * load. This asks it to switch right now via a dedicated MessageChannel port
 * (it replies with APPLY_UPDATE_RESULT { applied }), then reloads.
 *
 * Call this from your update prompt's "Refresh" button.
 *
 * @param {{ timeoutMs?: number, reload?: boolean, force?: boolean, checkTabs?: boolean, details?: boolean }} [options]
 * @returns {Promise<boolean | { applied: boolean, blockedByDirty?: boolean, dirtyTabs?: Array<{ tabId: string, title: string }> }>}
 */
export async function applyUpdate({ timeoutMs = 3000, reload = true, force = false, checkTabs = true, details = false } = {}) {
  if (!force && checkTabs) {
    const dirtyResult = await checkDirtyTabs();
    if (dirtyResult.hasDirtyTabs) {
      logger.warn(
        `[NLPWA] applyUpdate: update deferred because active tab(s) have unsaved changes: ` +
        dirtyResult.dirtyTabs.map((t) => t.title || t.tabId).join(', ')
      );
      safeDispatchEvent('nlpwa:update-deferred', { reason: 'dirty-tabs', dirtyTabs: dirtyResult.dirtyTabs });
      if (details) {
        return { applied: false, blockedByDirty: true, dirtyTabs: dirtyResult.dirtyTabs };
      }
      return false;
    }
  }

  let applied = null;
  try {
    const res = await requestFromSW(
      MESSAGE_TYPES.APPLY_UPDATE,
      {},
      MESSAGE_TYPES.APPLY_UPDATE_RESULT,
      timeoutMs
    );
    if (res && typeof res.applied === 'boolean') {
      applied = res.applied;
    }
  } catch (err) {
    // If no SW available or timeout occurs, log warning and fall through if reload desired
    logger.warn('[NLPWA] applyUpdate: SW reply timed out or not available:', err.message);
  }

  // If the SW explicitly replied that no update could be applied (e.g. not ready), abort reload
  if (applied === false) {
    logger.warn('[NLPWA] applyUpdate: no staged update ready to commit, reload aborted.');
    return details ? { applied: false, reason: 'not-ready' } : false;
  }

  if (reload && typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
    window.location.reload();
  }
  return details ? { applied: true } : true;
}

/**
 * Register a listener for update download/staging progress events.
 *
 * Also fires a `nlpwa:staging-progress` CustomEvent on `document`:
 *
 *   document.addEventListener('nlpwa:staging-progress', (e) => {
 *     console.log(`Progress: ${e.detail.percent}% (${e.detail.loaded}/${e.detail.total})`);
 *   });
 *
 * @param {(data: { version: string, loaded: number, total: number, percent: number, file?: string }) => void} callback
 * @returns {Function} unsubscribe function
 */
export function onStagingProgress(callback) {
  return onSWMessage(MESSAGE_TYPES.STAGING_PROGRESS, (data) => {
    safeDispatchEvent('nlpwa:staging-progress', {
      version: data.version,
      loaded: data.loaded,
      total: data.total,
      percent: data.percent,
      file: data.file,
    });
    if (typeof callback === 'function') {
      callback(data);
    }
  });
}

