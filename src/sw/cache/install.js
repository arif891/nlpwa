import { getConfig } from '../config/index.js';

/**
 * Pre-cache all files listed in config.precache into the offline cache.
 * Called during the SW `install` event via event.waitUntil().
 *
 * Uses Promise.allSettled so a single failed fetch doesn't abort the install.
 * Failed URLs are logged as warnings and will be retried on the next update check.
 */
export async function precacheFiles() {
  const { caches: cacheNames, precache } = getConfig();

  if (!precache.length) return;

  const cache = await caches.open(cacheNames.offline);

  // cache.addAll() would abort the entire install on any single failure.
  // Promise.allSettled + individual cache.add() calls give us partial success:
  // failed URLs are logged as warnings and retried on the next update check
  // (self-healing), while successfully cached files remain in place.
  const results = await Promise.allSettled(
    precache.map(url => cache.add(url))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
    } else {
      console.log(`[NLPWA] Precached: ${precache[i]}`);
    }
  });
}
