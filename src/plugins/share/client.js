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
        // Broadcasts to other open tabs notify with payload directly.
        // They do NOT drain the FIFO cache queue, which is reserved for the landing page!
        if (event.data?.data) {
          notifyShareListeners(event.data.data);
        }
      }
    });
  }

  // Also check if current URL indicates a share redirect
  if (typeof window !== 'undefined' && window.location) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('shared') || params.has('nlpwa_shared') || params.has('shareId')) {
        const shareId = params.get('shareId') || params.get('nlpwa_share_id') || undefined;
        getSharedData(shareId).then((data) => {
          if (data) notifyShareListeners(data);
        }).catch(() => {});
      }
    } catch {}
  }
}

/**
 * Retrieve any pending shared data received by the Service Worker via Web Share Target.
 *
 * @param {string} [shareId] Optional specific share ID to retrieve
 * @returns {Promise<Object|null>}
 */
export async function getSharedData(shareId) {
  try {
    const payload = shareId ? { shareId } : {};
    const response = await requestFromSW(SHARE_MESSAGE_TYPES.GET_SHARED_DATA, payload);
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
