import { BG_FETCH_MESSAGE_TYPES } from './constants.js';

/**
 * Check if the browser supports the Background Fetch API.
 *
 * @returns {boolean}
 */
export function isBackgroundFetchSupported() {
  return typeof self !== 'undefined' && 'BackgroundFetchManager' in self;
}

/**
 * Client class for scheduling and managing large background downloads.
 */
export class BackgroundFetchClient {
  constructor(options = {}) {
    this.options = options;
    this.successListeners = new Set();
    this.failListeners = new Set();
    this.abortListeners = new Set();
    this._initialized = false;
  }

  _initListeners() {
    if (this._initialized) return;
    this._initialized = true;

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener?.('message', (event) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === BG_FETCH_MESSAGE_TYPES.BG_FETCH_SUCCESS) {
          for (const fn of this.successListeners) {
            try { fn(data); } catch {}
          }
        } else if (data.type === BG_FETCH_MESSAGE_TYPES.BG_FETCH_FAIL) {
          for (const fn of this.failListeners) {
            try { fn(data); } catch {}
          }
        } else if (data.type === BG_FETCH_MESSAGE_TYPES.BG_FETCH_ABORT) {
          for (const fn of this.abortListeners) {
            try { fn(data); } catch {}
          }
        }
      });
    }
  }

  /**
   * Check if Background Fetch is supported by this browser.
   *
   * @returns {boolean}
   */
  isSupported() {
    return isBackgroundFetchSupported();
  }

  /**
   * Get active ServiceWorkerRegistration.
   *
   * @returns {Promise<ServiceWorkerRegistration|null>}
   */
  async getRegistration() {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      return navigator.serviceWorker.ready;
    }
    return null;
  }

  /**
   * Start a new background fetch download task.
   *
   * @param {string} id Unique identifier for this download task
   * @param {string[]|Request[]} requests URLs or Request objects to download
   * @param {{ title?: string, icons?: Array<{ src: string, sizes?: string, type?: string }>, downloadTotal?: number }} [options]
   * @returns {Promise<Object>} BackgroundFetchRegistration
   */
  async fetch(id, requests, options = {}) {
    this._initListeners();
    const reg = await this.getRegistration();
    if (!reg || !reg.backgroundFetch) {
      throw new Error('Background Fetch API is not supported or SW is not registered.');
    }
    return reg.backgroundFetch.fetch(id, requests, options);
  }

  /**
   * Retrieve an active background fetch task by ID.
   *
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async get(id) {
    const reg = await this.getRegistration();
    if (!reg || !reg.backgroundFetch) return null;
    return reg.backgroundFetch.get(id);
  }

  /**
   * Retrieve all active background fetch task IDs.
   *
   * @returns {Promise<string[]>}
   */
  async getIds() {
    const reg = await this.getRegistration();
    if (!reg || !reg.backgroundFetch) return [];
    return reg.backgroundFetch.getIds();
  }

  /**
   * Abort an active background fetch task.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async abort(id) {
    const task = await this.get(id);
    if (task && typeof task.abort === 'function') {
      return task.abort();
    }
    return false;
  }

  /**
   * Subscribe to background fetch completion events.
   *
   * @param {(data: { id: string, count: number, cacheName: string, storedRequests: string[] }) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onSuccess(callback) {
    this._initListeners();
    if (typeof callback === 'function') {
      this.successListeners.add(callback);
    }
    return () => {
      this.successListeners.delete(callback);
    };
  }

  /**
   * Subscribe to background fetch failure events.
   *
   * @param {(data: { id: string, failureReason: string }) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onFail(callback) {
    this._initListeners();
    if (typeof callback === 'function') {
      this.failListeners.add(callback);
    }
    return () => {
      this.failListeners.delete(callback);
    };
  }

  /**
   * Subscribe to background fetch cancellation events.
   *
   * @param {(data: { id: string }) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onAbort(callback) {
    this._initListeners();
    if (typeof callback === 'function') {
      this.abortListeners.add(callback);
    }
    return () => {
      this.abortListeners.delete(callback);
    };
  }
}

export const backgroundFetchClient = new BackgroundFetchClient();
