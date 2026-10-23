import { withStore, serializeRequest, deserializeRequest } from './idb.js';

export class SyncQueue {
  /**
   * @param {string} name Queue name
   * @param {Object} [options]
   * @param {number} [options.maxRetentionMs=86400000] Maximum age before discarding (default 24h)
   * @param {number} [options.maxRetries=5] Maximum attempts before discarding
   * @param {boolean} [options.stripAuthHeaders=false]
   * @param {number} [options.maxBodyBytes=10485760] Maximum request body size in bytes (default 10MB)
   * @param {RegExp|Function|string} [options.loginPattern=/(?:login|signin|auth)/i] Pattern to distinguish login redirects from normal redirects
   * @param {string} [options.idempotencyHeader='Idempotency-Key'] Header name for idempotency
   */
  constructor(name = 'default', options = {}) {
    this.name = name;
    this.maxRetentionMs = options.maxRetentionMs ?? 24 * 60 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 5;
    this.stripAuthHeaders = Boolean(options.stripAuthHeaders);
    this.maxBodyBytes = options.maxBodyBytes ?? (10 * 1024 * 1024);
    this.loginPattern = options.loginPattern ?? /(?:login|signin|auth)/i;
    this.idempotencyHeader = options.idempotencyHeader ?? 'Idempotency-Key';
  }

  /**
   * Check if a redirect URL represents a login / session-expired destination.
   * @param {string} url
   * @returns {boolean}
   * @private
   */
  _isLoginRedirect(url) {
    if (!url) return false;
    if (this.loginPattern instanceof RegExp) {
      return this.loginPattern.test(url);
    }
    if (typeof this.loginPattern === 'function') {
      return Boolean(this.loginPattern(url));
    }
    if (typeof this.loginPattern === 'string') {
      return url.includes(this.loginPattern);
    }
    return false;
  }

  /**
   * Enqueue a request for background sync.
   * @param {Request} request
   * @param {Object} [extraMeta]
   * @returns {Promise<number>} Auto-incremented ID of the queued request
   */
  async push(request, extraMeta = {}) {
    const record = await serializeRequest(request, {
      queueName: this.name,
      maxRetries: this.maxRetries,
      maxRetentionMs: this.maxRetentionMs,
      stripAuthHeaders: this.stripAuthHeaders,
      maxBodyBytes: this.maxBodyBytes,
      idempotencyHeader: this.idempotencyHeader,
      ...extraMeta,
    });

    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.add(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Retrieve all pending requests for this queue, moving expired items to dead-letter store.
   * @param {Object} [options]
   * @param {boolean} [options.includeDeadLetter=false] Include dead-letter items
   * @param {boolean} [options.deadLetterOnly=false] Return only dead-letter items
   * @param {boolean} [options.excludeAuthRequired=false] Exclude items awaiting re-authentication
   * @returns {Promise<Array<Object>>}
   */
  async getAll({ includeDeadLetter = false, deadLetterOnly = false, excludeAuthRequired = false } = {}) {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index('queueName');
        const req = index.getAll(IDBKeyRange.only(this.name));

        req.onsuccess = () => {
          const now = Date.now();
          const items = req.result || [];
          const valid = [];

          for (const item of items) {
            const age = now - (item.timestamp || 0);
            if (!item.deadLetter && age > (item.maxRetentionMs || this.maxRetentionMs)) {
              // Move expired active item to dead-letter store instead of vanishing silently
              const expiredRecord = {
                ...item,
                deadLetter: true,
                deadLetterReason: 'expired',
                failedAt: now,
              };
              store.put(expiredRecord);
              if (deadLetterOnly || includeDeadLetter) {
                valid.push(expiredRecord);
              }
            } else {
              if (deadLetterOnly) {
                if (item.deadLetter) valid.push(item);
              } else if (includeDeadLetter || !item.deadLetter) {
                if (excludeAuthRequired && item.authRequired) {
                  continue;
                }
                valid.push(item);
              }
            }
          }
          // Sort FIFO by timestamp and id
          valid.sort((a, b) => (a.timestamp - b.timestamp) || (a.id - b.id));
          resolve(valid);
        };

        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Retrieve all dead-letter requests for this queue.
   * @returns {Promise<Array<Object>>}
   */
  async getDeadLetter() {
    return this.getAll({ deadLetterOnly: true });
  }

  /**
   * Retry a dead-letter item by moving it back to the active queue.
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async retryDeadLetter(id) {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
          const item = req.result;
          if (!item) return resolve(false);
          const updated = {
            ...item,
            deadLetter: false,
            deadLetterReason: null,
            retryCount: 0,
            authRequired: false,
          };
          const putReq = store.put(updated);
          putReq.onsuccess = () => resolve(true);
          putReq.onerror = () => reject(putReq.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Clear all dead-letter requests in this queue.
   * @returns {Promise<void>}
   */
  async clearDeadLetter() {
    const items = await this.getDeadLetter();
    if (!items.length) return;
    return withStore('readwrite', (store) => {
      return Promise.all(
        items.map((item) => new Promise((resolve, reject) => {
          const req = store.delete(item.id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        }))
      );
    });
  }

  /**
   * Retrieve all items currently requiring authentication in this queue.
   * @returns {Promise<Array<Object>>}
   */
  async getAuthRequired() {
    const items = await this.getAll({ includeDeadLetter: true });
    return items.filter((item) => Boolean(item.authRequired));
  }

  /**
   * Reset the authRequired flag on an item or all items so they can be replayed after login.
   * @param {number} [id] If omitted, resets all authRequired items in this queue.
   * @param {Object} [options]
   * @param {HeadersInit} [options.headers] Optional fresh headers to attach (e.g. renewed Authorization token)
   * @returns {Promise<number>} Number of reset items
   */
  async retryAuthRequired(id, options = {}) {
    const newHeaders = options?.headers ? new Headers(options.headers) : null;
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index('queueName');
        const req = index.getAll(IDBKeyRange.only(this.name));
        req.onsuccess = () => {
          const items = req.result || [];
          let count = 0;
          for (const item of items) {
            if (item.authRequired && (id === undefined || item.id === id)) {
              let updatedHeaders = item.headers;
              if (newHeaders) {
                const h = new Headers(item.headers || []);
                newHeaders.forEach((v, k) => h.set(k, v));
                updatedHeaders = [];
                h.forEach((v, k) => updatedHeaders.push([k, v]));
              }
              store.put({
                ...item,
                headers: updatedHeaders,
                authRequired: false,
                retryCount: 0,
              });
              count++;
            }
          }
          resolve(count);
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Count pending active items in this queue.
   * @returns {Promise<number>}
   */
  async size() {
    const items = await this.getAll();
    return items.length;
  }

  /**
   * Remove a specific request by ID.
   * @param {number} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Clear all requests in this queue.
   * @returns {Promise<void>}
   */
  async clear() {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index('queueName');
        const req = index.openCursor(IDBKeyRange.only(this.name));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Clear all requests across all queues in the store (useful on user logout).
   * @returns {Promise<void>}
   */
  static async clearAll() {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Replay all pending requests in FIFO order.
   *
   * @param {Object} [options]
   * @param {Function} [options.fetchImpl] Fetch implementation (defaults to globalThis.fetch)
   * @param {(item: Object, response: Response) => void} [options.onReplaySuccess]
   * @param {(item: Object, error: Error|Response) => void} [options.onReplayFail]
   * @param {(item: Object, reason: string) => void} [options.onReplayDiscard]
   * @param {boolean} [options.includeAuthRequired=false] Whether to retry items flagged authRequired
   * @param {HeadersInit} [options.headers] Extra/fresh headers to attach to replayed requests
   * @param {(item: Object) => Promise<HeadersInit>|HeadersInit} [options.getHeaders] Dynamic header provider
   * @returns {Promise<{ successCount: number, failedCount: number, remainingCount: number, replayed: number, remaining: number }>}
   */
  async replayAll({ fetchImpl = globalThis.fetch, onReplaySuccess, onReplayFail, onReplayDiscard, includeAuthRequired = false, headers, getHeaders } = {}) {
    if (!SyncQueue._activeReplays) {
      SyncQueue._activeReplays = new Set();
    }

    const doReplay = async () => {
      const items = await this.getAll({ excludeAuthRequired: !includeAuthRequired });
      let successCount = 0;
      let failedCount = 0;

      for (const item of items) {
        let dynamicHeaders = headers;
        if (typeof getHeaders === 'function') {
          try {
            dynamicHeaders = await getHeaders(item);
          } catch (headerErr) {
            failedCount++;
            if (onReplayFail) onReplayFail(item, headerErr);
            continue;
          }
        }

        let req;
        try {
          req = deserializeRequest(item, {
            headers: dynamicHeaders,
            idempotencyHeader: this.idempotencyHeader,
          });
        } catch (deserializeErr) {
          failedCount++;
          const reason = 'deserialization_error';
          await withStore('readwrite', (store) => {
            store.put({
              ...item,
              deadLetter: true,
              deadLetterReason: reason,
              failedAt: Date.now(),
              lastError: deserializeErr?.message || String(deserializeErr),
            });
          });
          if (onReplayDiscard) onReplayDiscard(item, reason);
          if (onReplayFail) onReplayFail(item, deserializeErr);
          continue; // Corrupted request moved to dead-letter, remaining queue is unblocked!
        }

        try {
          const response = await fetchImpl(req);

          // Check for redirects (e.g. session-expired redirect vs POST-Redirect-GET)
          const isRedirected = Boolean(
            response.redirected ||
            response.type === 'opaqueredirect' ||
            (response.status >= 300 && response.status < 400)
          );

          if (isRedirected) {
            const redirectUrl = response.headers?.get?.('location') || response.url || '';
            const isLoginRedirect = this._isLoginRedirect(redirectUrl);

            if (isLoginRedirect) {
              // Real session expired or redirected to login: do NOT discard user data!
              failedCount++;
              await withStore('readwrite', (store) => {
                store.put({
                  ...item,
                  authRequired: true,
                  lastStatus: response.status,
                  redirected: true,
                  redirectUrl,
                });
              });
              if (onReplayFail) onReplayFail(item, response);
              continue;
            } else {
              // Standard POST-Redirect-GET or successful redirect (e.g. 303 to /orders/123)
              // Server accepted the request! Remove from queue and mark success
              await this.remove(item.id);
              successCount++;
              if (onReplaySuccess) onReplaySuccess(item, response);
              continue;
            }
          }

          if (response.ok || (response.status >= 200 && response.status < 300)) {
            // Success: remove from queue
            await this.remove(item.id);
            successCount++;
            if (onReplaySuccess) onReplaySuccess(item, response);
          } else {
            // Server error (4xx/5xx): record retry or move to dead-letter store
            failedCount++;
            const newRetryCount = (item.retryCount || 0) + 1;
            const maxRetries = item.maxRetries || this.maxRetries;

            if (response.status === 401 || response.status === 403) {
              // Auth error: do NOT discard user data! Flag authRequired so app can prompt re-login
              await withStore('readwrite', (store) => {
                store.put({ ...item, authRequired: true, lastStatus: response.status });
              });
            } else if (newRetryCount >= maxRetries || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
              // Unrecoverable client error (409 conflict, 422 unprocessable, etc.) or exceeded retries:
              // Move to dead-letter store so user data is NOT lost and application can inspect/retry it
              const reason = newRetryCount >= maxRetries ? 'max_retries_exceeded' : `http_${response.status}`;
              await withStore('readwrite', (store) => {
                store.put({
                  ...item,
                  deadLetter: true,
                  deadLetterReason: reason,
                  failedAt: Date.now(),
                  lastStatus: response.status,
                });
              });
              if (onReplayDiscard) onReplayDiscard(item, reason);
            } else {
              await withStore('readwrite', (store) => {
                store.put({ ...item, retryCount: newRetryCount, lastStatus: response.status });
              });
            }

            if (onReplayFail) onReplayFail(item, response);
          }
        } catch (err) {
          failedCount++;
          const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false) ||
            /offline|networkerror|failed to fetch/i.test(err?.message || '');

          if (isOffline) {
            // True offline network outage: do NOT count network outage against maxRetries eviction
            if (onReplayFail) onReplayFail(item, err);
            break; // Stop FIFO replay when network is demonstrably down
          }

          // Fetch error while online (e.g. CORS rejection, DNS error, bad endpoint)
          const newRetryCount = (item.retryCount || 0) + 1;
          const maxRetries = item.maxRetries || this.maxRetries;

          if (newRetryCount >= maxRetries) {
            const reason = 'max_retries_exceeded';
            await withStore('readwrite', (store) => {
              store.put({
                ...item,
                deadLetter: true,
                deadLetterReason: reason,
                failedAt: Date.now(),
                lastError: err?.message || String(err),
              });
            });
            if (onReplayDiscard) onReplayDiscard(item, reason);
            if (onReplayFail) onReplayFail(item, err);
            continue; // Bad request is dead-lettered, queue continues!
          } else {
            await withStore('readwrite', (store) => {
              store.put({
                ...item,
                retryCount: newRetryCount,
                lastError: err?.message || String(err),
              });
            });
            if (onReplayFail) onReplayFail(item, err);
            break;
          }
        }
      }

      const remainingCount = await this.size();
      return {
        successCount,
        failedCount,
        remainingCount,
        replayed: successCount,
        remaining: remainingCount,
      };
    };

    if (SyncQueue._activeReplays.has(this.name)) {
      const remainingCount = await this.size();
      return { successCount: 0, failedCount: 0, remainingCount, replayed: 0, remaining: remainingCount };
    }

    const nav = typeof navigator !== 'undefined'
      ? navigator
      : typeof self !== 'undefined'
        ? self.navigator
        : null;

    if (nav?.locks?.request && typeof nav.locks.request === 'function') {
      try {
        return await nav.locks.request(`nlpwa_sync_lock:${this.name}`, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            const remainingCount = await this.size();
            return { successCount: 0, failedCount: 0, remainingCount, replayed: 0, remaining: remainingCount };
          }
          SyncQueue._activeReplays.add(this.name);
          try {
            return await doReplay();
          } finally {
            SyncQueue._activeReplays.delete(this.name);
          }
        });
      } catch {
        // Fall back to in-memory lock
      }
    }

    SyncQueue._activeReplays.add(this.name);
    try {
      return await doReplay();
    } finally {
      SyncQueue._activeReplays.delete(this.name);
    }
  }
}
