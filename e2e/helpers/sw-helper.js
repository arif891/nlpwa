/**
 * Wait until the page is controlled by an active Service Worker.
 */
export async function waitForActiveSW(page) {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active && !!navigator.serviceWorker.controller;
  });
}

/**
 * Inspect CacheStorage keys across all caches in the browser.
 */
export async function getCacheNames(page) {
  return await page.evaluate(async () => {
    return await caches.keys();
  });
}

/**
 * Read the active pointer stored in nlpwa-meta.
 */
export async function getActivePointer(page) {
  return await page.evaluate(async () => {
    const metaCache = await caches.open('nlpwa-meta');
    const res = await metaCache.match('/_nlpwa/active.json');
    return res ? await res.json() : null;
  });
}

/**
 * Read cached snapshot from the active offline cache.
 */
export async function getActiveSnapshot(page, snapshotPath = '/_nlpwa/snapshot.json') {
  return await page.evaluate(async (path) => {
    const metaCache = await caches.open('nlpwa-meta');
    const activePointerRes = await metaCache.match('/_nlpwa/active.json');
    if (!activePointerRes) return null;
    const { cache } = await activePointerRes.json();
    const offlineCache = await caches.open(cache);
    const snapshotRes = await offlineCache.match(path);
    return snapshotRes ? await snapshotRes.json() : null;
  }, snapshotPath);
}

/**
 * Reset server version back to 1.0.0.
 */
export async function resetServerVersion(request) {
  const res = await request.post('/api/reset-version');
  return await res.json();
}
