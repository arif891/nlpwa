import { MESSAGE_TYPES } from '../shared/constants.js';
import { requestFromSW } from './messaging.js';

export { requestFromSW };

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
