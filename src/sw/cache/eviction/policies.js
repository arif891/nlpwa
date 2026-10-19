import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { matchGlob } from '../../../shared/glob.js';
import { CLEANUP_STRATEGIES, FETCH_CONCURRENCY } from '../../../shared/constants.js';
import { mapConcurrent } from '../../../shared/async.js';
import { getResponseMetadata, getStorageQuotaInfo } from './quota.js';
import { resolveByteSize } from './size.js';

let _cleanupQueue = Promise.resolve();

/**
 * Execute cleanup on the runtime cache using one or more strategies.
 *
 * Supported options:
 * - strategy: 'largest' | 'lru' | 'max-age' | 'quota' | 'pattern' | 'all' (default: 'lru')
 * - maxItemMB / maxItemKB / maxItemBytes / maxItem: evict any individual file larger than this limit
 * - minItemMB / minItemKB / minItemBytes / minItem: evict any individual file >= this limit
 * - maxTotalMB / maxTotalKB / maxTotalBytes / maxTotal: evict items until total runtime cache is <= limit
 * - maxEntries: evict items until total remaining count is <= limit
 * - maxAgeMs: evict items older than this age in ms
 * - match | pattern: glob pattern to match URLs to evict (for 'pattern' strategy)
 * - maxQuotaPercent: for 'quota' strategy, evict until usage percentage is <= this value (default: 80)
 * - maxQuotaMB / maxQuotaKB / maxQuotaBytes: for 'quota' strategy, evict until usage is <= limit
 * - preferLargest: for 'quota' strategy, evict largest entries first (default: true)
 * - count: limit number of items to evict
 *
 * @param {Object} [options]
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
export async function cleanRuntimeCache(options = {}) {
  const prev = _cleanupQueue;
  let runResolver;
  _cleanupQueue = new Promise((resolve) => { runResolver = resolve; });

  const run = async () => {
    const strategy = options.strategy || CLEANUP_STRATEGIES.LRU;

    const maxTotalBytes = resolveByteSize(options.maxTotalBytes ?? options.maxTotal, options.maxTotalMB, options.maxTotalKB);
    const maxItemBytes = resolveByteSize(options.maxItemBytes ?? options.maxItem, options.maxItemMB, options.maxItemKB);
    const minItemBytes = resolveByteSize(options.minItemBytes ?? options.minItem, options.minItemMB, options.minItemKB);
    const maxQuotaBytes = resolveByteSize(options.maxQuotaBytes ?? options.maxQuota, options.maxQuotaMB, options.maxQuotaKB);

    const { caches: cacheNames } = getConfig();
    const cache = await caches.open(cacheNames.runtime);
    const requests = await cache.keys();

    const allItems = [];
    let totalBytes = 0;

    const itemEntries = await mapConcurrent(requests, FETCH_CONCURRENCY, async (req) => {
      const res = await cache.match(req);
      if (!res) return null;
      const meta = await getResponseMetadata(res);
      return {
        req,
        url: typeof req === 'string' ? req : req.url,
        size: meta.size,
        cachedAt: meta.cachedAt,
      };
    });

    for (const item of itemEntries) {
      if (item) {
        totalBytes += item.size;
        allItems.push(item);
      }
    }

    const toEvictSet = new Set();
    let remainingBytes = totalBytes;

    const markForEviction = (item) => {
      if (!toEvictSet.has(item)) {
        toEvictSet.add(item);
        remainingBytes = Math.max(0, remainingBytes - item.size);
      }
    };

    // 1. Filter: individual item size thresholds
    if (maxItemBytes != null) {
      for (const item of allItems) {
        if (item.size > maxItemBytes) {
          markForEviction(item);
        }
      }
    }
    if (minItemBytes != null) {
      for (const item of allItems) {
        if (item.size >= minItemBytes) {
          markForEviction(item);
        }
      }
    }

    // 2. Filter: individual max age / TTL
    if (options.maxAgeMs != null && strategy !== CLEANUP_STRATEGIES.MAX_AGE) {
      const cutoff = Date.now() - options.maxAgeMs;
      for (const item of allItems) {
        if (item.cachedAt > 0 && item.cachedAt < cutoff) {
          markForEviction(item);
        }
      }
    }

    // 3. Strategy evaluation on remaining items
    const candidates = allItems.filter(item => !toEvictSet.has(item));

    if (strategy === CLEANUP_STRATEGIES.ALL) {
      for (const item of candidates) {
        markForEviction(item);
      }
    } else if (strategy === CLEANUP_STRATEGIES.PATTERN) {
      const pattern = options.match || options.pattern;
      if (pattern) {
        for (const item of candidates) {
          if (matchGlob(pattern, item.url)) {
            markForEviction(item);
          }
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.MAX_AGE) {
      const maxAgeMs = options.maxAgeMs ?? (7 * 24 * 60 * 60 * 1000); // 7 days default
      const cutoff = Date.now() - maxAgeMs;
      for (const item of candidates) {
        if (item.cachedAt > 0 && item.cachedAt < cutoff) {
          markForEviction(item);
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.LARGEST) {
      // Sort descending by size (largest files first)
      candidates.sort((a, b) => b.size - a.size);

      let currentRemainingCount = allItems.length - toEvictSet.size;

      for (const item of candidates) {
        const needsSizeEviction = maxTotalBytes != null && remainingBytes > maxTotalBytes;
        const needsCountEviction = options.maxEntries != null && currentRemainingCount > options.maxEntries;
        const hitLimit = options.count != null && toEvictSet.size >= options.count;

        if (hitLimit) break;
        if (needsSizeEviction || needsCountEviction) {
          markForEviction(item);
          currentRemainingCount--;
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.LRU) {
      let lruCandidates = candidates;
      if (options.match || options.pattern) {
        const pattern = options.match || options.pattern;
        lruCandidates = candidates.filter(item => matchGlob(pattern, item.url));
      }
      // Sort ascending by cachedAt (oldest first)
      lruCandidates.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));

      let currentRemainingCount = lruCandidates.length;

      for (const item of lruCandidates) {
        const needsCountEviction = options.maxEntries != null && currentRemainingCount > options.maxEntries;
        const needsSizeEviction = maxTotalBytes != null && remainingBytes > maxTotalBytes;
        const hitLimit = options.count != null && toEvictSet.size >= options.count;

        if (hitLimit) break;
        if (needsCountEviction || needsSizeEviction) {
          markForEviction(item);
          currentRemainingCount--;
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.QUOTA) {
      const quotaInfo = await getStorageQuotaInfo();
      const maxQuotaPercent = options.maxQuotaPercent ?? 80;

      let currentUsage = quotaInfo.usage ?? totalBytes;
      const quota = quotaInfo.quota;

      const isOverQuota = () => {
        if (quota && maxQuotaPercent != null) {
          if ((currentUsage / quota) * 100 > maxQuotaPercent) return true;
        }
        if (maxQuotaBytes != null && currentUsage > maxQuotaBytes) return true;
        return false;
      };

      if (isOverQuota()) {
        if (options.preferLargest !== false) {
          candidates.sort((a, b) => b.size - a.size);
        } else {
          candidates.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
        }

        for (const item of candidates) {
          if (!isOverQuota()) break;
          markForEviction(item);
          currentUsage = Math.max(0, currentUsage - item.size);
        }
      }
    }

    // 4. Perform deletions
    const evicted = [...toEvictSet];
    let freedBytes = 0;

    await mapConcurrent(evicted, 8, async (item) => {
      freedBytes += item.size;
      await cache.delete(item.req);
    });

    const finalRemainingEntries = allItems.length - evicted.length;
    const finalRemainingBytes = Math.max(0, totalBytes - freedBytes);
    const updatedQuota = await getStorageQuotaInfo();

    logger.log(
      `[NLPWA] Runtime cache cleaned (${strategy}): ${evicted.length} evicted, ` +
      `${(freedBytes / 1024).toFixed(1)} KB freed, ${finalRemainingEntries} remaining`
    );

    return {
      success: true,
      strategy,
      evictedCount: evicted.length,
      evictedUrls: evicted.map(item => item.url),
      freedBytes,
      remainingEntries: finalRemainingEntries,
      remainingBytes: finalRemainingBytes,
      quota: updatedQuota,
    };
  };

  try {
    await prev.catch(() => {});
    return await run();
  } finally {
    runResolver();
  }
}
