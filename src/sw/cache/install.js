import { getConfig, updateActiveConfig, loadConfigFromCache } from '../config/index.js';

/**
 * Pre-cache all files listed in config.precache into the offline cache.
 * Called during the SW `install` event via event.waitUntil().
 *
 * First fetches and caches the runtime config file (e.g. /config.json)
 * in the offline cache, then precaches the app shell files.
 */
export async function precacheFiles() {
  const config = getConfig();
  const cacheNames = config.caches;
  const configPath = config.configPath || '/config.json';
  const offlineCache = await caches.open(cacheNames.offline);

  // 1. Fetch & store config file in offline cache
  try {
    const configRes = await fetch(configPath, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (configRes.ok) {
      await offlineCache.put(configPath, configRes.clone());
      const runtimeConfig = await configRes.json();
      updateActiveConfig(runtimeConfig);
      console.log(`[NLPWA] Runtime config cached: ${configPath}`);
    } else {
      console.warn(`[NLPWA] Could not fetch ${configPath} (HTTP ${configRes.status})`);
      await loadConfigFromCache();
    }
  } catch (err) {
    console.warn(`[NLPWA] Network error fetching ${configPath}:`, err.message);
    await loadConfigFromCache();
  }

  // 2. Precache files defined in config.precache
  const activeConfig = getConfig();
  const precache = activeConfig.precache || [];

  if (!precache.length) return;

  const results = await Promise.allSettled(
    precache.map(url => offlineCache.add(url))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
    } else {
      console.log(`[NLPWA] Precached: ${precache[i]}`);
    }
  });
}
