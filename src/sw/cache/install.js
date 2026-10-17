import { getConfig, updateActiveConfig, loadConfigFromCache } from '../config/index.js';
import { tryAcquire, release, openActive } from './store.js';
import { fetchServerManifest, loadCachedSnapshot } from '../update/manifest.js';
import { stageUpdate } from '../update/stage.js';
import { commitStaged } from '../update/commit.js';

/**
 * Install-time caching, called from the SW `install` event.
 *
 * Normal path: take the server manifest and run the same stage → verify →
 * commit pipeline as an update. On a first install nothing is running yet, so
 * the staged cache is switched in immediately. When upgrading from an older
 * SW the app is already running, so the staged cache waits for the next
 * navigation like any other update.
 *
 * Because the snapshot is written during install, the first update check sees
 * an up-to-date app instead of re-downloading everything.
 *
 * Fallback (no manifest, e.g. `nlpwa update` was never run): precache from
 * config.precache without hashes. The first update check then builds the
 * hashed snapshot.
 */
export async function precacheFiles() {
  if (!tryAcquire()) return;
  try {
    let manifest = null;
    try {
      manifest = await fetchServerManifest();
    } catch (err) {
      console.warn(`[NLPWA] No update manifest at install (${err.message})`);
    }

    const activeSnapshot = await loadCachedSnapshot();

    if (manifest) {
      const swChanged = Boolean(activeSnapshot?.swVersion && activeSnapshot.swVersion !== getConfig().version);
      const result = await stageUpdate(manifest, { activeSnapshot, forceRefetch: swChanged });
      // Incomplete staging is resumed by the update check on activate.
      if (result.status === 'ready' && !activeSnapshot) await commitStaged();
      return;
    }

    if (!activeSnapshot) await precacheWithoutManifest();
  } finally {
    release();
  }
}

async function precacheWithoutManifest() {
  const config = getConfig();
  const configPath = config.configPath || '/config.json';
  
  const offlineCache = await openActive(config.caches.offline);

  try {
    const configRes = await fetch(configPath, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (configRes.ok) {
      const cloned = configRes.clone();
      const data = await configRes.json();
      await offlineCache.put(configPath, cloned);
      updateActiveConfig(data);
    } else {
      console.warn(`[NLPWA] Could not fetch ${configPath} (HTTP ${configRes.status})`);
      await loadConfigFromCache();
    }
  } catch (err) {
    console.warn(`[NLPWA] Network error fetching ${configPath}:`, err.message);
    await loadConfigFromCache();
  }

  const precache = getConfig().precache || [];
  // cache: 'reload' skips the HTTP cache so stale bytes are never stored
  const results = await Promise.allSettled(
    precache.map((url) => offlineCache.add(new Request(new URL(url, self.location.href), { cache: 'reload' })))
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') console.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
  });
}
