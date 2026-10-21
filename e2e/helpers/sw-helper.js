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
    // Check IndexedDB
    try {
      const idbPointer = await new Promise((resolve) => {
        const req = indexedDB.open('nlpwa-meta');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) return resolve(null);
          const tx = db.transaction('meta', 'readonly');
          const getReq = tx.objectStore('meta').get('/_nlpwa/active.json');
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
      if (idbPointer) return idbPointer;
    } catch {}

    // Fallback to CacheStorage if present
    try {
      const metaCache = await caches.open('nlpwa-meta');
      const res = await metaCache.match('/_nlpwa/active.json');
      return res ? await res.json() : null;
    } catch {
      return null;
    }
  });
}

/**
 * Read cached snapshot from the active offline cache.
 */
export async function getActiveSnapshot(page, snapshotPath = '/_nlpwa/snapshot.json') {
  return await page.evaluate(async (path) => {
    let activeCacheName = null;
    try {
      activeCacheName = await new Promise((resolve) => {
        const req = indexedDB.open('nlpwa-meta');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) return resolve(null);
          const tx = db.transaction('meta', 'readonly');
          const getReq = tx.objectStore('meta').get('/_nlpwa/active.json');
          getReq.onsuccess = () => resolve(getReq.result?.cache || null);
          getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {}

    if (!activeCacheName) {
      try {
        const metaCache = await caches.open('nlpwa-meta');
        const res = await metaCache.match('/_nlpwa/active.json');
        if (res) activeCacheName = (await res.json())?.cache;
      } catch {}
    }

    if (!activeCacheName) return null;
    const offlineCache = await caches.open(activeCacheName);
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
