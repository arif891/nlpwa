import { getConfig, updateActiveConfig, loadConfigFromCache } from '../config/index.js';
import { logger } from '../logger.js';
import { tryAcquire, release, openActive, withLock } from './store.js';
import { fetchServerInfo, loadCachedSnapshot } from '../update/manifest.js';
import { stageUpdate } from '../update/stage.js';
import { commitStaged } from '../update/commit.js';
import { resolvePathWithBase } from '../../shared/url.js';

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
 *
 * @returns {Promise<Object|undefined>}
 */
export async function precacheFiles() {
  let manifest = null;
  try {
    manifest = await fetchServerInfo();
  } catch (err) {
    logger.warn(`[NLPWA] No update manifest at install (${err.message})`);
  }

  const activeSnapshot = await loadCachedSnapshot();

  if (manifest) {
    return withLock(async () => {
      const swChanged = Boolean(activeSnapshot?.swVersion && activeSnapshot.swVersion !== getConfig().version);
      const result = await stageUpdate(manifest, { activeSnapshot, forceRefetch: swChanged });
      if (result.status === 'incomplete' && !activeSnapshot) {
        throw new Error(`[NLPWA] Precache incomplete on first install: ${result.failed.join(', ')} failed`);
      }
      if (result.status === 'ready' && !activeSnapshot) {
        await commitStaged();
      }
      return result;
    });
  }

  if (!activeSnapshot) {
    return withLock(async () => {
      return await precacheWithoutManifest();
    });
  }
}

async function precacheWithoutManifest() {
  const config = getConfig();
  const rawConfigPath = config.configPath || '/config.json';
  const configPath = resolvePathWithBase(rawConfigPath, config.base);
  
  const offlineCache = await openActive(config.caches.offline);

  try {
    const configRes = await fetch(configPath, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (configRes.ok) {
      const cloned1 = configRes.clone();
      const cloned2 = configPath !== rawConfigPath ? configRes.clone() : null;
      const data = await configRes.json();
      await offlineCache.put(configPath, cloned1);
      if (cloned2) {
        await offlineCache.put(rawConfigPath, cloned2);
      }
      updateActiveConfig(data);
    } else {
      logger.warn(`[NLPWA] Could not fetch ${configPath} (HTTP ${configRes.status})`);
      await loadConfigFromCache();
    }
  } catch (err) {
    logger.warn(`[NLPWA] Network error fetching ${configPath}:`, err.message);
    await loadConfigFromCache();
  }

  const precache = (getConfig().precache || []).filter((u) => typeof u === 'string' && !u.includes('*') && !u.includes('?'));
  // cache: 'reload' skips the HTTP cache so stale bytes are never stored
  const results = await Promise.allSettled(
    precache.map(async (url) => {
      const resolved = resolvePathWithBase(url, config.base);
      const req = new Request(new URL(resolved, self.location.href), { cache: 'reload' });
      await offlineCache.add(req);
      if (resolved !== url) {
        const match = await offlineCache.match(req);
        if (match) await offlineCache.put(url, match.clone());
      }
    })
  );
  const failed = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
      failed.push(precache[i]);
    }
  });

  if (failed.length > 0) {
    throw new Error(`[NLPWA] Precache failed on first install: ${failed.join(', ')} failed`);
  }

  return { status: 'ready', precached: precache.length };
}
