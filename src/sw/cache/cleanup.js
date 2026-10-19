import { getConfig } from '../config/index.js';
import { logger } from '../logger.js';
import { matchGlob } from '../../shared/glob.js';
import { CLEANUP_STRATEGIES, FETCH_CONCURRENCY } from '../../shared/constants.js';

/**
 * Extract size (bytes) and cached timestamp (ms) from a cached Response.
 *
 * @param {Response} res
 * @returns {Promise<{ size: number, cachedAt: number }>}
 */
async function getResponseMetadata(res) {
  let size = 0;
  const sizeHeader = res.headers?.get('X-NLPWA-Content-Length') || res.headers?.get('Content-Length');
  if (sizeHeader) {
    const parsed = parseInt(sizeHeader, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) size = parsed;
  } else {
    try {
      const buf = await res.clone().arrayBuffer();
      size = buf.byteLength;
    } catch {
      size = 0;
    }
  }

  let cachedAt = 0;
  const cachedAtHeader = res.headers?.get('X-NLPWA-Cached-At');
  if (cachedAtHeader) {
    const parsed = parseInt(cachedAtHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
  } else {
    const dateHeader = res.headers?.get('Date');
    if (dateHeader) {
      const parsed = new Date(dateHeader).getTime();
      if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
    }
  }

  return { size, cachedAt };
}

/**
 * Run an async mapper over items with bounded concurrency.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapConcurrent(items, limit, fn) {
  if (!items || items.length === 0) return [];
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Query current storage quota and runtime cache usage metrics.
 *
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
export async function getStorageQuotaInfo() {
  let quota = null;
  let usage = null;
  let percentUsed = null;
  let remaining = null;

  const storage =
    (typeof self !== 'undefined' && self.navigator?.storage) ||
    (typeof navigator !== 'undefined' && navigator?.storage);

  if (storage && typeof storage.estimate === 'function') {
    try {
      const estimate = await storage.estimate();
      quota = estimate.quota ?? null;
      usage = estimate.usage ?? null;
      if (quota && usage != null) {
        percentUsed = Number(((usage / quota) * 100).toFixed(2));
        remaining = Math.max(0, quota - usage);
      }
    } catch {
      // Storage estimate not supported or denied
    }
  }

  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.runtime);
  const requests = await cache.keys();

  let runtimeBytes = 0;
  const entries = [];

  const itemMetas = await mapConcurrent(requests, FETCH_CONCURRENCY, async (req) => {
    const res = await cache.match(req);
    if (!res) return null;
    const meta = await getResponseMetadata(res);
    return {
      url: typeof req === 'string' ? req : req.url,
      size: meta.size,
      cachedAt: meta.cachedAt,
    };
  });

  for (const item of itemMetas) {
    if (item) {
      runtimeBytes += item.size;
      entries.push(item);
    }
  }

  // Top 5 largest entries
  const largestEntries = [...entries]
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);

  return {
    quota,
    usage,
    percentUsed,
    remaining,
    runtimeEntries: requests.length,
    runtimeBytes,
    largestEntries,
  };
}

/**
 * Parse a size option accepting bytes, KB, MB, GB, or string (e.g. '50MB', '500KB').
 *
 * @param {number|string|undefined} bytesVal
 * @param {number|undefined} mbVal
 * @param {number|undefined} kbVal
 * @returns {number|null}
 */
export function resolveByteSize(bytesVal, mbVal, kbVal) {
  if (bytesVal != null) {
    if (typeof bytesVal === 'string') {
      const match = bytesVal.trim().match(/^([\d.]+)\s*(gb|mb|kb|b)?$/i);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = (match[2] || 'b').toLowerCase();
        if (unit === 'gb') return Math.round(num * 1024 * 1024 * 1024);
        if (unit === 'mb') return Math.round(num * 1024 * 1024);
        if (unit === 'kb') return Math.round(num * 1024);
        return Math.round(num);
      }
    }
    const parsed = Number(bytesVal);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (mbVal != null) {
    const parsed = Number(mbVal);
    return Number.isNaN(parsed) ? null : Math.round(parsed * 1024 * 1024);
  }
  if (kbVal != null) {
    const parsed = Number(kbVal);
    return Number.isNaN(parsed) ? null : Math.round(parsed * 1024);
  }
  return null;
}

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
let _cleanupQueue = Promise.resolve();

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
        // By default prefer evicting largest files to recover quota fastest
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
