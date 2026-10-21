import { MESSAGE_TYPES } from '../shared/constants.js';

/**
 * Send a typed message to the active Service Worker.
 *
 * @param {Object} message
 * @returns {Promise<void>}
 */
export async function sendToSW(message) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
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
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }
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

/**
 * Send a request message to the active Service Worker and await a response.
 * Uses MessageChannel when supported for dedicated 1-to-1 reply, with fallback
 * to navigator.serviceWorker message event listener.
 *
 * @param {string} type
 * @param {Object} [payload]
 * @param {string} [replyType]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export async function requestFromSW(type, payload = {}, replyType = '', timeoutMs = 5000) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('[NLPWA] Service Workers are not supported in this environment.');
  }

  let registration = null;
  if (navigator.serviceWorker.controller) {
    // Fast-path: controller is already controlling this window
  } else if (navigator.serviceWorker.ready) {
    let readyTimer;
    const readyTimeout = new Promise((_, reject) => {
      readyTimer = setTimeout(() => {
        reject(new Error(`[NLPWA] Timed out waiting for Service Worker ready state (${timeoutMs}ms)`));
      }, timeoutMs);
    });
    try {
      registration = await Promise.race([navigator.serviceWorker.ready, readyTimeout]);
    } finally {
      clearTimeout(readyTimer);
    }
  }

  const sw = navigator.serviceWorker.controller || registration?.active;
  if (!sw) {
    throw new Error('[NLPWA] No active Service Worker controller found.');
  }

  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // 1. MessageChannel for direct 1-to-1 reply (standard in modern browsers)
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error(`[NLPWA] Request timed out after ${timeoutMs}ms (${type})`));
      }, timeoutMs);

      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data?.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data?.data ?? event.data);
        }
      };

      sw.postMessage({ type, requestId, ...payload }, [channel.port2]);
    });
  }

  // 2. Fallback via global navigator.serviceWorker message event listener
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (event) => {
      if (
        (event.data?.type === replyType || event.data?.type === type) &&
        (!event.data?.requestId || event.data.requestId === requestId)
      ) {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', listener);
        if (event.data?.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data?.data ?? event.data);
        }
      }
    };

    timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', listener);
      reject(new Error(`[NLPWA] Request timed out after ${timeoutMs}ms (${type})`));
    }, timeoutMs);

    navigator.serviceWorker.addEventListener('message', listener);
    sw.postMessage({ type, requestId, ...payload });
  });
}

/**
 * Query active and staged versions from the Service Worker.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<{ activeVersion: string|null, stagedVersion: string|null, swVersion: string|null }>}
 */
export async function getVersion(timeoutMs = 5000) {
  try {
    const res = await requestFromSW(
      MESSAGE_TYPES.GET_VERSION,
      {},
      MESSAGE_TYPES.VERSION_INFO,
      timeoutMs
    );
    return res || { activeVersion: null, stagedVersion: null, swVersion: null };
  } catch {
    return { activeVersion: null, stagedVersion: null, swVersion: null };
  }
}

/**
 * Query current update lifecycle status from the Service Worker.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<'idle' | 'checking' | 'staging' | 'ready' | 'applying'>}
 */
export async function getStatus(timeoutMs = 5000) {
  try {
    const res = await requestFromSW(
      MESSAGE_TYPES.GET_STATUS,
      {},
      MESSAGE_TYPES.STATUS_INFO,
      timeoutMs
    );
    if (res?.commitDeferred) return 'commit-deferred';
    return res?.status || 'idle';
  } catch {
    return 'idle';
  }
}

