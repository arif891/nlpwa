import { MESSAGE_TYPES } from '../shared/constants.js';
import { onSWMessage } from './messaging.js';

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
    document.dispatchEvent(
      new CustomEvent('nlpwa:update-ready', {
        bubbles: true,
        detail: { version: data.version },
      })
    );

    // Direct callback
    if (typeof callback === 'function') {
      callback({ version: data.version });
    }
  });
}

/**
 * Reload the current page to apply the waiting SW version.
 * Call this from your update prompt's "Refresh" button.
 */
export function applyUpdate() {
  window.location.reload();
}
