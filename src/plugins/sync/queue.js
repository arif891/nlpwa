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
   * @returns {Promise<Array<Object>>}
   */
  async getAll() {
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
              valid.push(item);
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
   * Count pending items in this queue.
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
   * Replay all pending requests in FIFO order.
   *
   * @param {Object} [options]
   * @param {Function} [options.fetchImpl] Fetch implementation (defaults to globalThis.fetch)
   * @param {(item: Object, response: Response) => void} [options.onReplaySuccess]
   * @param {(item: Object, error: Error|Response) => void} [options.onReplayFail]
   * @returns {Promise<{ successCount: number, failedCount: number, remainingCount: number }>}
   */
  async replayAll({ fetchImpl = globalThis.fetch, onReplaySuccess, onReplayFail } = {}) {
    const items = await this.getAll();
    let successCount = 0;
    let failedCount = 0;

    for (const item of items) {
      const req = deserializeRequest(item);
      try {
        const response = await fetchImpl(req);
        if (response.ok || (response.status >= 200 && response.status < 400)) {
          // Success: remove from queue
          await this.remove(item.id);
          successCount++;
          if (onReplaySuccess) onReplaySuccess(item, response);
        } else {
          // Server error (4xx/5xx): record retry or discard if unrecoverable client error
          failedCount++;
          const newRetryCount = (item.retryCount || 0) + 1;
          const maxRetries = item.maxRetries || this.maxRetries;

          if (response.status === 401 || response.status === 403) {
            // Auth error: do NOT discard user data! Flag authRequired so app can prompt re-login
            await withStore('readwrite', (store) => {
              store.put({ ...item, authRequired: true, lastStatus: response.status });
            });
          } else if (newRetryCount >= maxRetries || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
            // Discard client fatal errors or exceeded retries
            await this.remove(item.id);
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
