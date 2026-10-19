import { getConfig } from '../../config/index.js';
import { FETCH_CONCURRENCY } from '../../../shared/constants.js';
import { mapConcurrent } from '../../../shared/async.js';

/**
 * Extract size (bytes) and cached timestamp (ms) from a cached Response.
 *
 * @param {Response} res
 * @returns {Promise<{ size: number, cachedAt: number }>}
 */
export async function getResponseMetadata(res) {
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
