import { MESSAGE_TYPES } from '../shared/constants.js';
import { onSWMessage, sendToSW } from './messaging.js';

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
 * @param {(data: { version: string, partial: boolean }) => void} [callback]
 * @returns {Function}  unsubscribe — call when the listening component unmounts
 */
export function onUpdateReady(callback) {
  return onSWMessage(MESSAGE_TYPES.UPDATE_READY, (data) => {
    // Dispatch CustomEvent for decoupled listeners
    document.dispatchEvent(
      new CustomEvent('nlpwa:update-ready', {
        bubbles: true,
        detail: { version: data.version, partial: Boolean(data.partial) },
      })
    );

    // Direct callback
    if (typeof callback === 'function') {
      callback({ version: data.version, partial: Boolean(data.partial) });
    }
  });
}

/**
 * Switch to the staged update, then reload the page.
 *
 * The SW builds updates in the background and only makes them live on a page
 * load. This asks it to switch right now (it replies UPDATE_APPLIED), then
 * reloads. If the SW doesn't answer within `timeoutMs` the page reloads
 * anyway, because a reload is itself a navigation that triggers the switch.
 *
 * Call this from your update prompt's "Refresh" button.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function applyUpdate({ timeoutMs = 3000 } = {}) {
  try {
    let off = () => {};
    const reply = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      off = onSWMessage(MESSAGE_TYPES.UPDATE_APPLIED, () => { clearTimeout(timer); resolve(); });
    });
    await sendToSW({ type: MESSAGE_TYPES.APPLY_UPDATE });
    await reply;
    off();
  } catch {
    // no service worker available - fall through to the reload
  }
  window.location.reload();
}
