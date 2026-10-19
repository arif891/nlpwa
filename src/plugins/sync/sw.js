import { SyncQueue } from './queue.js';
import { SYNC_MESSAGE_TYPES } from './constants.js';

export class BackgroundSyncPlugin {
  /**
   * @param {string|Object} [options]
   * @param {string} [options.queueName='default'] Queue name
   * @param {number} [options.maxRetentionMs=86400000] Retention time in ms
   * @param {number} [options.maxRetries=5] Max retries per request
   * @param {string[]} [options.methods=['POST', 'PUT', 'PATCH', 'DELETE']] HTTP methods to intercept
   * @param {boolean} [options.allMethods=false] If true, intercepts all methods including GET
   */
  constructor(options = {}) {
    const queueName = typeof options === 'string' ? options : (options.queueName || 'default');
    const queueOptions = typeof options === 'object' ? options : {};

    this.queueName = queueName;
    this.queue = new SyncQueue(queueName, queueOptions);
    this.syncTag = `nlpwa-sync:${queueName}`;
    this.methods = new Set(queueOptions.methods || ['POST', 'PUT', 'PATCH', 'DELETE']);
    this.allMethods = Boolean(queueOptions.allMethods);

    this._bindServiceWorkerEvents();
  }

  _bindServiceWorkerEvents() {
    if (typeof self === 'undefined') return;

    // 1. Listen for browser Background Sync event
    if ('addEventListener' in self) {
      self.addEventListener('sync', (event) => {
        if (event.tag === this.syncTag || event.tag === 'nlpwa-sync:all') {
          event.waitUntil(this.replay());
        }
      });

      // 2. Listen for client postMessages
      self.addEventListener('message', (event) => {
        const type = event.data?.type;
        const targetQueue = event.data?.queue;

        // If a targetQueue was explicitly specified and does not match, ignore
        if (targetQueue && targetQueue !== this.queueName) return;

        const port = event.ports?.[0];
        const reply = (replyType, data, error) => {
          const payload = {
            type: replyType,
            requestId: event.data?.requestId,
            data: data ?? null,
            error: error ? (error.message || String(error)) : undefined,
          };
          if (port) {
            port.postMessage(payload);
          } else {
            event.source?.postMessage(payload);
          }
        };

        if (type === SYNC_MESSAGE_TYPES.SYNC_REPLAY) {
          const promise = this.replay()
            .then((result) => reply(SYNC_MESSAGE_TYPES.SYNC_REPLAY_RESULT, result))
            .catch((err) => reply(SYNC_MESSAGE_TYPES.SYNC_REPLAY_RESULT, null, err));

          if (event.waitUntil) event.waitUntil(promise);
        } else if (type === SYNC_MESSAGE_TYPES.SYNC_GET_PENDING) {
          const promise = this.queue.getAll()
            .then((items) => {
              reply(SYNC_MESSAGE_TYPES.SYNC_PENDING_INFO, {
                queue: this.queueName,
                count: items.length,
                items: items.map((item) => ({
                  id: item.id,
                  url: item.url,
                  method: item.method,
                  timestamp: item.timestamp,
                  retryCount: item.retryCount,
                })),
              });
            })
            .catch((err) => reply(SYNC_MESSAGE_TYPES.SYNC_PENDING_INFO, null, err));

          if (event.waitUntil) event.waitUntil(promise);
        } else if (type === SYNC_MESSAGE_TYPES.SYNC_CLEAR) {
          const promise = this.queue.clear()
            .then(() => reply(SYNC_MESSAGE_TYPES.SYNC_CLEARED, { queue: this.queueName, success: true }))
            .catch((err) => reply(SYNC_MESSAGE_TYPES.SYNC_CLEARED, null, err));

          if (event.waitUntil) event.waitUntil(promise);
        }
      });
    }
  }

  /**
   * NLPWA fetch plugin hook: invoked whenever an outgoing fetch throws or network drops.
   *
   * @param {Object} context
   * @param {Request} context.request
   * @param {Request} [context.originalRequest]
   * @param {Error} context.error
   * @param {FetchEvent} [context.event]
   */
  async fetchDidFail({ request, originalRequest, error, event }) {
    const reqToQueue = originalRequest || request;
    if (!this.allMethods && !this.methods.has(reqToQueue.method)) {
      return;
    }

    try {
      const id = await this.queue.push(reqToQueue);

      // Attempt to register background sync if browser supports it
      if (typeof self !== 'undefined' && self.registration && 'sync' in self.registration) {
        try {
          await self.registration.sync.register(this.syncTag);
        } catch {
          // Browser sync registration might fail or be denied
        }
      }

      await this._notifyClients({
        type: SYNC_MESSAGE_TYPES.SYNC_ENQUEUED,
        queue: this.queueName,
        id,
        url: reqToQueue.url,
        method: reqToQueue.method,
      });
    } catch (enqueueErr) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[NLPWA Sync] Failed to enqueue request for ${reqToQueue.url}:`, enqueueErr);
      }
    }
  }

  /**
   * Replay all queued items in this queue.
   * @returns {Promise<{ successCount: number, failedCount: number, remainingCount: number }>}
   */
  async replay() {
    return this.queue.replayAll({
      fetchImpl: (req) => fetch(req),
      onReplaySuccess: (item, response) => {
        this._notifyClients({
          type: 'NLPWA_SYNC_ITEM_SUCCESS',
          queue: this.queueName,
          id: item.id,
          url: item.url,
          status: response.status,
        });
      },
      onReplayFail: (item, err) => {
        this._notifyClients({
          type: 'NLPWA_SYNC_ITEM_FAILED',
          queue: this.queueName,
          id: item.id,
          url: item.url,
          error: err?.message || String(err),
        });
      },
    });
  }

  async _notifyClients(message) {
    if (typeof self === 'undefined' || !self.clients) return;
    try {
      const allClients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage(message);
      }
    } catch {
      // Ignored
    }
  }
}
