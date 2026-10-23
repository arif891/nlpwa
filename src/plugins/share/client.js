import { requestFromSW } from '../../client/messaging.js';
import { SHARE_MESSAGE_TYPES } from './constants.js';

const _shareListeners = new Set();
let _initialized = false;

function notifyShareListeners(data) {
  for (const listener of _shareListeners) {
    try {
      listener(data);
    } catch {}
  }
}

function initShareListener() {
  if (_initialized) return;
  _initialized = true;

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener?.('message', (event) => {
      if (event.data?.type === SHARE_MESSAGE_TYPES.SHARED_DATA) {
        getSharedData().then((data) => {
          if (data) notifyShareListeners(data);
          else if (event.data?.data) notifyShareListeners(event.data.data);
        }).catch(() => {
          if (event.data?.data) notifyShareListeners(event.data.data);
        });
      }
    });
  }

  // Also check if current URL indicates a share redirect
  if (typeof window !== 'undefined' && window.location) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('shared') || params.has('nlpwa_shared')) {
        getSharedData().then((data) => {
          if (data) notifyShareListeners(data);
        }).catch(() => {});
      }
    } catch {}
  }
}

/**
 * Retrieve any pending shared data received by the Service Worker via Web Share Target.
 *
 * @returns {Promise<Object|null>}
 */
export async function getSharedData() {
  try {
    const response = await requestFromSW(SHARE_MESSAGE_TYPES.GET_SHARED_DATA);
    return response || null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to Web Share Target events when files or text are shared to the app.
 *
 * @param {(sharedData: { title?: string, text?: string, url?: string, files?: Array<any>, timestamp?: number }) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onShareTarget(callback) {
  initShareListener();
  if (typeof callback === 'function') {
    _shareListeners.add(callback);
  }
  return () => {
    _shareListeners.delete(callback);
  };
}

/**
 * Client class for managing Web Share Target interactions.
 */
export class ShareTargetClient {
  getSharedData() {
    return getSharedData();
  }

  onShareTarget(callback) {
    return onShareTarget(callback);
  }
}

export const shareTargetClient = new ShareTargetClient();
