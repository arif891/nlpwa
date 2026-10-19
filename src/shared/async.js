/**
 * Run an async mapper over items with bounded concurrency.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit Maximum concurrent async operations
 * @param {(item: T, index: number) => Promise<R>} fn Async mapping callback
 * @returns {Promise<R[]>}
 */
export async function mapConcurrent(items, limit, fn) {
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
