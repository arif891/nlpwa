import { MESSAGE_TYPES } from '../shared/constants.js';

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

  const registration = await navigator.serviceWorker.ready;
  const sw = navigator.serviceWorker.controller || registration.active;
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
 * Request storage quota and runtime cache usage metrics from the Service Worker.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   quota: number|null,
 *   usage: number|null,
 *   percentUsed: number|null,
 *   remaining: number|null,
 *   runtimeEntries: number,
 *   runtimeBytes: number,
 *   largestEntries: Array<{ url: string, size: number, cachedAt: number }>
 * }>}
 */
export async function getCacheInfo({ timeoutMs = 3000 } = {}) {
  return requestFromSW(MESSAGE_TYPES.GET_CACHE_INFO, {}, MESSAGE_TYPES.CACHE_INFO, timeoutMs);
}

/**
 * Request cleanup on the runtime cache.
 *
 * Supported options:
 * - strategy: 'largest' | 'lru' | 'max-age' | 'quota' | 'pattern' | 'all' (default: 'lru')
 * - maxItemBytes: evict any individual file larger than this byte size
 * - minItemBytes: evict any individual file with size >= this byte size
 * - maxTotalBytes: evict entries until total runtime cache size is <= this limit
 * - maxEntries: evict entries until total remaining count is <= this limit
 * - maxAgeMs: evict entries older than this age in ms
 * - maxQuotaPercent: for 'quota' strategy, evict until usage percentage is <= this value
 * - maxQuotaBytes: for 'quota' strategy, evict until total usage is <= this value
 * - preferLargest: for 'quota' strategy, evict largest entries first (default: true)
 * - match: glob pattern to match URLs to evict (for 'pattern' strategy)
 * - count: limit maximum number of items to evict
 *
 * @param {Object} [cleanupOptions]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   strategy: string,
 *   evictedCount: number,
 *   evictedUrls: string[],
 *   freedBytes: number,
 *   remainingEntries: number,
 *   remainingBytes: number,
 *   quota: Object
 * }>}
 */
export async function cleanupRuntimeCache(cleanupOptions = {}, { timeoutMs = 10000 } = {}) {
  return requestFromSW(
    MESSAGE_TYPES.CLEANUP_RUNTIME,
    { options: cleanupOptions },
    MESSAGE_TYPES.RUNTIME_CLEANED,
    timeoutMs
  );
}
