import { SYNC_MESSAGE_TYPES } from './constants.js';
import { SyncQueue } from './queue.js';
import { requestFromSW, onSWMessage } from '../../client/messaging.js';

export class SyncClient {
  /**
   * @param {string} [defaultQueue='default']
   */
  constructor(defaultQueue = 'default') {
    this.defaultQueue = defaultQueue;
    this._listeners = new Map();
    this._initListeners();
  }

  _initListeners() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    navigator.serviceWorker.addEventListener('message', (event) => {
      const type = event.data?.type;
      if (!type) return;

      if (type === SYNC_MESSAGE_TYPES.SYNC_ENQUEUED) {
        this._emit('enqueued', event.data);
      } else if (type === 'NLPWA_SYNC_ITEM_SUCCESS') {
        this._emit('success', event.data);
      } else if (type === 'NLPWA_SYNC_ITEM_FAILED') {
        this._emit('failed', event.data);
      }
    });
  }

  /**
   * Subscribe to sync events.
   * Events: 'enqueued' | 'success' | 'failed'
   *
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    const cbs = this._listeners.get(event);
    if (cbs) {
      for (const cb of cbs) {
        try {
          cb(data);
        } catch (err) {
          console.error(`[NLPWA SyncClient] Listener error on ${event}:`, err);
        }
      }
    }
  }

  /**
   * Get pending requests for a queue.
   *
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ queue: string, count: number, items: Array<Object> }>}
   */
  async getPending(queueName = this.defaultQueue, { timeoutMs = 3000 } = {}) {
    try {
      return await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_GET_PENDING,
        { queue: queueName },
        SYNC_MESSAGE_TYPES.SYNC_PENDING_INFO,
        timeoutMs
      );
    } catch {
      // Fallback: Read directly from IndexedDB if SW is not responding
      const localQueue = new SyncQueue(queueName);
      const items = await localQueue.getAll();
      return {
        queue: queueName,
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          url: i.url,
          method: i.method,
          timestamp: i.timestamp,
          retryCount: i.retryCount,
        })),
      };
    }
  }

  /**
   * Trigger replay of a queue.
   *
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ successCount: number, failedCount: number, remainingCount: number }>}
   */
  async replay(queueName = this.defaultQueue, { timeoutMs = 15000 } = {}) {
    try {
      return await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_REPLAY,
        { queue: queueName },
        SYNC_MESSAGE_TYPES.SYNC_REPLAY_RESULT,
        timeoutMs
      );
    } catch {
      // Fallback: Replay directly via local queue if SW is not responsive
      const localQueue = new SyncQueue(queueName);
      return await localQueue.replayAll({
        onReplaySuccess: (item, res) => this._emit('success', { queue: queueName, id: item.id, url: item.url, status: res.status }),
        onReplayFail: (item, err) => this._emit('failed', { queue: queueName, id: item.id, url: item.url, error: err?.message || err }),
      });
    }
  }

  /**
   * Clear all pending requests in a queue.
   *
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async clear(queueName = this.defaultQueue, { timeoutMs = 3000 } = {}) {
    try {
      await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_CLEAR,
        { queue: queueName },
        SYNC_MESSAGE_TYPES.SYNC_CLEARED,
        timeoutMs
      );
      return true;
    } catch {
      const localQueue = new SyncQueue(queueName);
      await localQueue.clear();
      return true;
    }
  }

  /**
   * Get dead-letter requests for a queue that failed permanently (4xx errors or exceeded retries).
   *
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ queue: string, count: number, items: Array<Object> }>}
   */
  async getDeadLetter(queueName = this.defaultQueue, { timeoutMs = 3000 } = {}) {
    try {
      return await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_GET_DEAD_LETTER,
        { queue: queueName },
        SYNC_MESSAGE_TYPES.SYNC_DEAD_LETTER_INFO,
        timeoutMs
      );
    } catch {
      const localQueue = new SyncQueue(queueName);
      const items = await localQueue.getDeadLetter();
      return {
        queue: queueName,
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          url: i.url,
          method: i.method,
          timestamp: i.timestamp,
          retryCount: i.retryCount,
          deadLetterReason: i.deadLetterReason,
          lastStatus: i.lastStatus,
          failedAt: i.failedAt,
        })),
      };
    }
  }

  /**
   * Retry a dead-letter request by moving it back to the active queue.
   *
   * @param {number} id
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async retryDeadLetter(id, queueName = this.defaultQueue, { timeoutMs = 3000 } = {}) {
    try {
      const res = await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_RETRY_DEAD_LETTER,
        { queue: queueName, id },
        SYNC_MESSAGE_TYPES.SYNC_RETRY_DEAD_LETTER_RESULT,
        timeoutMs
      );
      return Boolean(res?.success);
    } catch {
      const localQueue = new SyncQueue(queueName);
      return await localQueue.retryDeadLetter(id);
    }
  }

  /**
   * Clear dead-letter requests for a queue.
   *
   * @param {string} [queueName]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async clearDeadLetter(queueName = this.defaultQueue, { timeoutMs = 3000 } = {}) {
    try {
      await requestFromSW(
        SYNC_MESSAGE_TYPES.SYNC_CLEAR_DEAD_LETTER,
        { queue: queueName },
        SYNC_MESSAGE_TYPES.SYNC_CLEAR_DEAD_LETTER_RESULT,
        timeoutMs
      );
      return true;
    } catch {
      const localQueue = new SyncQueue(queueName);
      await localQueue.clearDeadLetter();
      return true;
    }
  }

  /**
   * Clear all pending and dead-letter requests across ALL queues.
   * Recommended to call on user logout to purge sensitive authorization headers and payloads.
   *
   * @returns {Promise<void>}
   */
  async clearOnLogout() {
    await SyncQueue.clearAll();
  }

  /**
   * Automatically replay queue when browser regains network connectivity or tab becomes visible.
   * Essential for Safari / Firefox which lack native Background Sync API.
   *
   * @param {string} [queueName]
   * @returns {Function} Cleanup function to remove event listeners
   */
  autoSyncOnOnline(queueName = this.defaultQueue) {
    if (typeof window === 'undefined') return () => {};

    const trigger = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      this.replay(queueName).catch(() => {});
    };

    const onOnline = () => trigger();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') trigger();
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
}

export const syncClient = new SyncClient();
