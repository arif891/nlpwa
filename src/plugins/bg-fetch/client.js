import {
  BG_FETCH_MESSAGE_TYPES,
  BG_FETCH_ID_PREFIX,
  getBgFetchIdForUrl,
  getUrlFromBgFetchId,
} from './constants.js';

export { getBgFetchIdForUrl, getUrlFromBgFetchId };

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
   * Start a new background fetch download or upload task.
   * If downloadTotal or uploadTotal are omitted, automatically attempts to
   * inspect HEAD Content-Length or Request body size where possible.
   *
   * @param {string} id Unique identifier for this task
   * @param {string[]|Request[]} requests URLs or Request objects to download
   * @param {{
   *   title?: string,
   *   icons?: Array<{ src: string, sizes?: string, type?: string }>,
   *   downloadTotal?: number,
   *   uploadTotal?: number,
   *   autoDetermineTotals?: boolean
   * }} [options]
   * @returns {Promise<Object>} BackgroundFetchRegistration
   */
  async fetch(id, requests, options = {}) {
    this._initListeners();
    const reg = await this.getRegistration();
    if (!reg || !reg.backgroundFetch) {
      throw new Error('Background Fetch API is not supported or SW is not registered.');
    }

    let finalOptions = { ...options };
    const reqList = Array.isArray(requests) ? requests : [requests];

    // Auto-detect uploadTotal if request body is a Blob/File
    if (finalOptions.uploadTotal === undefined) {
      let uploadSum = 0;
      let hasUploads = false;
      for (const req of reqList) {
        if (req && typeof req === 'object' && req.method && req.method.toUpperCase() !== 'GET') {
          if (req.body && typeof req.body.size === 'number') {
            uploadSum += req.body.size;
            hasUploads = true;
          }
        }
      }
      if (hasUploads && uploadSum > 0) {
        finalOptions.uploadTotal = uploadSum;
      }
    }

    // Auto-detect downloadTotal via HEAD request if enabled (defaults to true for GET requests when omitted)
    if (finalOptions.downloadTotal === undefined && finalOptions.autoDetermineTotals !== false) {
      let downloadSum = 0;
      let hasDownloads = false;
      for (const req of reqList) {
        const isGet = typeof req === 'string' || (req && (!req.method || req.method.toUpperCase() === 'GET'));
        if (isGet) {
          const url = typeof req === 'string' ? req : req.url;
          try {
            if (typeof fetch === 'function') {
              const headRes = await fetch(url, { method: 'HEAD' });
              const len = headRes.headers?.get?.('content-length');
              if (len && Number(len) > 0) {
                downloadSum += Number(len);
                hasDownloads = true;
              }
            }
          } catch {
            // Silently ignore if HEAD fails (e.g. offline, CORS restricted), browser will use indeterminate bar
          }
        }
      }
      if (hasDownloads && downloadSum > 0) {
        finalOptions.downloadTotal = downloadSum;
      }
    }

    const bgRegistration = await reg.backgroundFetch.fetch(id, requests, finalOptions);
    if (typeof options.onProgress === 'function') {
      this.onProgress(bgRegistration, options.onProgress);
    }
    return bgRegistration;
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
   * Retrieve an active background fetch task for a given URL (using its deterministic ID).
   *
   * @param {string} url
   * @returns {Promise<Object|null>}
   */
  async getForUrl(url) {
    return this.get(getBgFetchIdForUrl(url));
  }

  /**
   * Track live download/upload progress for an active BackgroundFetchRegistration or task ID/URL.
   *
   * @param {string|Object} target Task ID, URL, or BackgroundFetchRegistration object
   * @param {(progress: {
   *   id: string,
   *   downloaded: number,
   *   downloadTotal: number,
   *   uploaded: number,
   *   uploadTotal: number,
   *   percent: number|null
   * }) => void} callback
   * @returns {Promise<() => void>} unsubscribe function
   */
  async onProgress(target, callback) {
    if (typeof callback !== 'function') return () => {};

    let registration = null;
    if (typeof target === 'object' && target !== null && typeof target.addEventListener === 'function') {
      registration = target;
    } else if (typeof target === 'string') {
      registration = await this.get(target);
      if (!registration && !target.startsWith(BG_FETCH_ID_PREFIX)) {
        registration = await this.getForUrl(target);
      }
    }

    if (!registration) {
      return () => {};
    }

    const handler = () => {
      const downloaded = registration.downloaded || 0;
      const downloadTotal = registration.downloadTotal || 0;
      const uploaded = registration.uploaded || 0;
      const uploadTotal = registration.uploadTotal || 0;

      let percent = null;
      if (downloadTotal > 0) {
        percent = Math.round((downloaded / downloadTotal) * 100);
      } else if (uploadTotal > 0) {
        percent = Math.round((uploaded / uploadTotal) * 100);
      }

      try {
        callback({
          id: registration.id,
          downloaded,
          downloadTotal,
          uploaded,
          uploadTotal,
          percent,
        });
      } catch {}
    };

    registration.addEventListener?.('progress', handler);
    // Fire immediately with current state
    handler();

    return () => {
      try {
        registration.removeEventListener?.('progress', handler);
      } catch {}
    };
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
