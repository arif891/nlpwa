import { MESSAGE_TYPES } from '../shared/constants.js';

/**
 * Send a typed message to the active Service Worker.
 *
 * @param {Object} message
 * @returns {Promise<void>}
 */
export async function sendToSW(message) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const sw = navigator.serviceWorker.controller || registration?.active;
  sw?.postMessage(message);
}

/**
 * Listen for typed messages from the Service Worker.
 *
 * @param {string}   type     one of MESSAGE_TYPES
 * @param {Function} handler  called with the full message data object
 * @returns {Function}        call to unsubscribe
 */
export function onSWMessage(type, handler) {
  const listener = (event) => {
    if (event.data?.type === type) handler(event.data);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}

/**
 * Trigger a manual update check from the client side.
 * The SW will respond with UPDATE_READY or NO_UPDATE.
 *
 * @returns {Promise<void>}
 */
export function requestUpdateCheck() {
  return sendToSW({ type: MESSAGE_TYPES.CHECK_UPDATE });
}
