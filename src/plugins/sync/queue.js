import { withStore, serializeRequest, deserializeRequest } from './idb.js';

export class SyncQueue {
  /**
   * @param {string} name Queue name
   * @param {Object} [options]
   * @param {number} [options.maxRetentionMs=86400000] Maximum age before discarding (default 24h)
   * @param {number} [options.maxRetries=5] Maximum attempts before discarding
   */
  constructor(name = 'default', options = {}) {
    this.name = name;
    this.maxRetentionMs = options.maxRetentionMs ?? 24 * 60 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 5;
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
   * Retrieve all pending requests for this queue, pruning expired ones.
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
            if (age > (item.maxRetentionMs || this.maxRetentionMs)) {
              // Expired, delete from store
              store.delete(item.id);
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
    return withStore('readwrite', (store) => {
      for (const item of items) {
        store.delete(item.id);
      }
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
   * @returns {Promise<number>} Number of reset items
   */
  async retryAuthRequired(id) {
    return withStore('readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const index = store.index('queueName');
        const req = index.getAll(IDBKeyRange.only(this.name));
        req.onsuccess = () => {
          const items = req.result || [];
          let count = 0;
          for (const item of items) {
            if (item.authRequired && (id === undefined || item.id === id)) {
              store.put({
                ...item,
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
      store.delete(id);
    });
  }

  /**
   * Clear all requests in this queue.
   * @returns {Promise<void>}
   */
  async clear() {
    return withStore('readwrite', (store) => {
      const index = store.index('queueName');
      const req = index.openCursor(IDBKeyRange.only(this.name));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
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
   * @param {boolean} [options.includeAuthRequired=false] Whether to retry items flagged authRequired
   * @returns {Promise<{ successCount: number, failedCount: number, remainingCount: number }>}
   */
  async replayAll({ fetchImpl = globalThis.fetch, onReplaySuccess, onReplayFail, includeAuthRequired = false } = {}) {
    const items = await this.getAll({ excludeAuthRequired: !includeAuthRequired });
    let successCount = 0;
    let failedCount = 0;

    for (const item of items) {
      const req = deserializeRequest(item);
      try {
        const response = await fetchImpl(req);

        // Check for redirects (e.g. session-expired redirect to login page)
        const isRedirected = Boolean(
          response.redirected ||
          response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)
        );

        if (isRedirected) {
          // Session expired or redirected to login: do NOT discard user data!
          failedCount++;
          await withStore('readwrite', (store) => {
            store.put({
              ...item,
              authRequired: true,
              lastStatus: response.status,
              redirected: true,
              redirectUrl: response.url || null,
            });
          });
          if (onReplayFail) onReplayFail(item, response);
          continue;
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
            await withStore('readwrite', (store) => {
              store.put({
                ...item,
                deadLetter: true,
                deadLetterReason: newRetryCount >= maxRetries ? 'max_retries_exceeded' : `http_${response.status}`,
                failedAt: Date.now(),
                lastStatus: response.status,
              });
            });
          } else {
            await withStore('readwrite', (store) => {
              store.put({ ...item, retryCount: newRetryCount, lastStatus: response.status });
            });
          }

          if (onReplayFail) onReplayFail(item, response);
        }
      } catch (err) {
        // Network error (offline or timeout): do NOT count network outage against maxRetries eviction
        failedCount++;
        if (onReplayFail) onReplayFail(item, err);
        break; // Stop FIFO replay when network is demonstrably down
      }
    }

    const remainingCount = await this.size();
    return { successCount, failedCount, remainingCount };
  }
}
