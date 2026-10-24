import { getConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { openActive, getStaged, setStaged } from '../../cache/store.js';
import { computeDiff, isSafePath } from '../diff.js';
import { writeSnapshot } from '../manifest.js';
import { cleanRuntimeCache } from '../../cache/cleanup.js';
import {
  MAX_RETRY_ATTEMPTS,
  FETCH_CONCURRENCY,
  MESSAGE_TYPES,
  DEFAULT_PROGRESS_THROTTLE_MS,
  MAX_BACKOFF_MS,
} from '../../../shared/constants.js';
import { resolvePathWithBase } from '../../../shared/url.js';
import { mapConcurrent } from '../../../shared/async.js';
import { isAlreadyStaged } from './verifier.js';
import { fetchVerified } from './fetcher.js';

export { isAlreadyStaged, fetchVerified };

/**
 * Build the new app version in a SEPARATE cache while the active one keeps
 * serving. Nothing here is visible to the running app until commitStaged().
 *
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} manifest
 * @param {{ activeSnapshot?: Object|null, forceRefetch?: boolean }} [opts]
 * @returns {Promise<
 *   { status: 'ready', failed: string[], reused: number, copied: number, fetched: number } |
 *   { status: 'incomplete', failed: string[], retryCount: number }
 * >}
 */
export async function stageUpdate(manifest, { activeSnapshot = null, forceRefetch = false } = {}) {
  const config = getConfig();
  const verify = config.verifyHashes ?? (config.publicKey ? 'strict' : 'warn');
  const maxVerifyBytes = config.maxVerifyBytes ?? (25 * 1024 * 1024);
  const allowOversizedUnverified = config.allowOversizedUnverified ?? true;
  const largeFileThresholdBytes = config.largeFileThresholdBytes ?? config.maxVerifyBytes ?? (25 * 1024 * 1024);
  const files = manifest.files.filter((f) => isSafePath(f?.path));
  const activeHashes = new Map((activeSnapshot?.files ?? []).map((f) => [f.path, f.hash]));

  const respectSaveData = config.staging?.respectSaveData ?? config.respectSaveData ?? false;
  const maxUpdateBytes = config.staging?.maxUpdateBytes ?? config.maxUpdateBytes ?? 0;
  const wifiOnlyThresholdBytes = config.staging?.wifiOnlyThresholdBytes ?? config.wifiOnlyThresholdBytes ?? 0;

  const conn = typeof navigator !== 'undefined' ? navigator?.connection : null;
  if (respectSaveData && conn?.saveData === true) {
    logger.log('[NLPWA] Staging deferred: saveData is enabled on client connection.');
    return {
      status: 'deferred',
      reason: 'save-data',
    };
  }

  const networkFiles = files.filter((f) => !(!forceRefetch && activeSnapshot && f.hash && activeHashes.get(f.path) === f.hash));
  const estimatedDeltaBytes = networkFiles.reduce((acc, f) => acc + (f.size || 0), 0);

  if (maxUpdateBytes > 0 && estimatedDeltaBytes > maxUpdateBytes) {
    logger.warn(
      `[NLPWA] Staging rejected: update delta (${estimatedDeltaBytes} bytes) exceeds maxUpdateBytes budget (${maxUpdateBytes} bytes).`
    );
    return {
      status: 'budget-exceeded',
      reason: 'budget-exceeded',
      estimatedDeltaBytes,
      maxUpdateBytes,
    };
  }

  const isCellularOrMetered = conn && (
    conn.type === 'cellular' ||
    conn.type === 'bluetooth' ||
    conn.type === 'wimax' ||
    conn.metered === true
  );
  if (wifiOnlyThresholdBytes > 0 && isCellularOrMetered && estimatedDeltaBytes > wifiOnlyThresholdBytes) {
    logger.log(
      `[NLPWA] Staging deferred: update delta (${estimatedDeltaBytes} bytes) exceeds wifiOnlyThresholdBytes (${wifiOnlyThresholdBytes} bytes) on cellular/metered connection.`
    );
    return {
      status: 'deferred',
      reason: 'wifi-only',
      estimatedDeltaBytes,
      wifiOnlyThresholdBytes,
    };
  }

  const diff = computeDiff(files, activeSnapshot?.files ?? null);
  const evict = [...diff.modified, ...diff.removed];

  let staged = await getStaged();
  const resumable = staged && !staged.complete
    && staged.version === manifest.version && staged.swVersion === config.version;

  if (!resumable) {
    if (staged?.cache) await caches.delete(staged.cache);
    staged = {
      cache: `${config.caches.offline}@${manifest.version}-${Date.now().toString(36)}`,
      version: manifest.version,
      swVersion: config.version,
      complete: false,
      retryCount: 0,
    };
  }

  // Record the staging cache BEFORE creating it so a crash can never orphan it
  await setStaged(staged);

  const next = await caches.open(staged.cache);
  const activeCache = activeSnapshot ? await openActive(config.caches.offline) : null;

  const stats = { reused: 0, copied: 0, fetched: 0, fetchedBytes: 0 };
  const failed = [];
  const failedDetails = {};

  const putWithQuotaRecovery = async (path, res, reacquire = null) => {
    try {
      await next.put(path, res);
    } catch (err) {
      const isQuota = err.name === 'QuotaExceededError' || /quota/i.test(err.message || '');
      if (isQuota) {
        logger.warn(`[NLPWA] QuotaExceededError while staging ${path}. Freeing runtime cache space...`);
        const cleaned = await cleanRuntimeCache({ strategy: 'all' }).catch(() => null);
        if (cleaned && (cleaned.freedBytes > 0 || cleaned.evictedCount > 0)) {
          const retryCopy = reacquire ? await reacquire() : (res.bodyUsed ? null : res);
          if (retryCopy) {
            await next.put(path, retryCopy);
            return;
          }
        }
      }
      throw err;
    }
  };

  let processedCount = 0;
  const totalFiles = files.length;
  let lastProgressBroadcast = 0;
  let progressTimeout = null;
  let latestProgressPayload = null;

  const broadcastProgress = (payload) => {
    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        clients.forEach((c) => c.postMessage(payload));
      }).catch(() => {});
    }
  };

  const notifyProgress = (filePath) => {
    processedCount++;
    const rawPercent = totalFiles > 0 ? Math.floor((processedCount / totalFiles) * 100) : 100;
    const percent = processedCount >= totalFiles ? 100 : Math.min(99, rawPercent);
    const payload = {
      type: MESSAGE_TYPES.STAGING_PROGRESS,
      version: manifest.version,
      loaded: processedCount,
      total: totalFiles,
      percent,
      file: filePath,
      fetchedBytes: stats.fetchedBytes,
    };
    latestProgressPayload = payload;

    const now = Date.now();
    if (percent === 100) {
      if (progressTimeout) {
        clearTimeout(progressTimeout);
        progressTimeout = null;
      }
      lastProgressBroadcast = now;
      broadcastProgress(payload);
      return;
    }

    const throttleMs = config.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    if (now - lastProgressBroadcast >= throttleMs) {
      if (progressTimeout) {
        clearTimeout(progressTimeout);
        progressTimeout = null;
      }
      lastProgressBroadcast = now;
      broadcastProgress(payload);
    } else if (!progressTimeout) {
      progressTimeout = setTimeout(() => {
        progressTimeout = null;
        lastProgressBroadcast = Date.now();
        if (latestProgressPayload) {
          broadcastProgress(latestProgressPayload);
        }
      }, throttleMs - (now - lastProgressBroadcast));
    }
  };

  const inFlightBgFetches = [];
  await mapConcurrent(files, FETCH_CONCURRENCY, async ({ path, hash, size, skipVerify }) => {
    const fetchUrl = resolvePathWithBase(path, config.base);
    try {
      if (await isAlreadyStaged({
        cache: next,
        path,
        expected: hash,
        verify,
        maxVerifyBytes,
        fileSize: size,
        fetchUrl,
        allowOversizedUnverified,
        skipVerify,
      })) {
        stats.reused++;
        notifyProgress(path);
        return;
      }
      if (!forceRefetch && activeCache && hash && activeHashes.get(path) === hash) {
        const hit = (await activeCache.match(fetchUrl)) || (fetchUrl !== path ? await activeCache.match(path) : null);
        if (hit) {
          await putWithQuotaRecovery(fetchUrl, hit, async () => {
            return (await activeCache.match(fetchUrl)) || (fetchUrl !== path ? await activeCache.match(path) : null);
          });
          stats.copied++;
          notifyProgress(path);
          return;
        }
      }
      const doFetch = () => fetchVerified({
        path: fetchUrl,
        expected: hash,
        verify,
        maxVerifyBytes,
        largeFileThresholdBytes,
        fileSize: size,
        allowOversizedUnverified,
        skipVerify,
      });
      const fetchedRes = await doFetch();
      const contentLen = fetchedRes.headers?.get?.('content-length');
      const bytes = contentLen ? Number(contentLen) : (size || 0);
      stats.fetchedBytes += (bytes || 0);
      await putWithQuotaRecovery(fetchUrl, fetchedRes, doFetch);
      stats.fetched++;
      notifyProgress(path);
    } catch (err) {
      if (err?.isBackgroundFetchPending) {
        inFlightBgFetches.push(path);
        logger.log(`[NLPWA] Asset ${fetchUrl} is currently downloading in background via Background Fetch.`);
        return;
      }
      failed.push(path);
      failedDetails[path] = err.message;
      logger.warn(`[NLPWA] Staging failed: ${fetchUrl} - ${err.message}`);
    }
  });

  if (progressTimeout) {
    clearTimeout(progressTimeout);
    progressTimeout = null;
  }
  latestProgressPayload = null;

  // If assets are actively downloading in the background via native Background Fetch and no hard failures occurred:
  if (inFlightBgFetches.length > 0 && failed.length === 0) {
    logger.log(
      `[NLPWA] Staging v${manifest.version} in progress via Background Fetch: ` +
      `${inFlightBgFetches.length} file(s) downloading (${inFlightBgFetches.join(', ')}). Active version remains live.`
    );
    await setStaged({
      ...staged,
      pendingBackgroundFetches: inFlightBgFetches,
      failedFiles: [],
      failedDetails: {},
      nextRetryAt: null,
      complete: false,
    });
    return {
      status: 'downloading-background',
      pendingBackgroundFetches: inFlightBgFetches,
      stats,
    };
  }

  const retryCount = failed.length ? staged.retryCount + 1 : 0;

  if (failed.length > 0) {
    const prevFailed = staged.failedFiles ?? [];
    const isSameFiles = prevFailed.length > 0
      && failed.length === prevFailed.length
      && failed.every((f) => prevFailed.includes(f));

    const hasHashMismatch = Object.values(failedDetails).some(
      (msg) => typeof msg === 'string' && msg.includes('hash mismatch')
    );
    const hasQuotaExceeded = Object.values(failedDetails).some(
      (msg) => typeof msg === 'string' && (msg.includes('QuotaExceededError') || /quota/i.test(msg))
    );

    let nextRetryAt = null;
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      const maxBackoff = config.maxBackoffMs ?? MAX_BACKOFF_MS;
      const backoffMs = Math.min(60000 * Math.pow(2, Math.min(retryCount - MAX_RETRY_ATTEMPTS, 6)), maxBackoff);
      nextRetryAt = Date.now() + backoffMs;
      logger.warn(
        `[NLPWA] Staging incomplete: ${failed.length} file(s) failed after ${retryCount} attempts: ` +
        `${failed.join(', ')}. Active version remains live.`
      );
    }

    if (isSameFiles && retryCount >= 2) {
      if (hasHashMismatch) {
        logger.error(
          `[NLPWA] Persistent hash mismatch on ${failed.join(', ')} across ${retryCount} attempts. ` +
          `A CDN, proxy, or host minification may be altering file contents in transit. ` +
          `Consider setting verifyHashes: 'warn' or false in your nlpwa config if this transformation is expected.`
        );
      } else {
        logger.warn(
          `[NLPWA] Repeated staging failure on the same file(s): ${failed.join(', ')} (${retryCount} attempts).`
        );
      }
    }

    await setStaged({
      ...staged,
      retryCount,
      failedFiles: failed,
      failedDetails,
      nextRetryAt,
      complete: false,
    });

    return {
      status: 'incomplete',
      failed,
      failedDetails,
      retryCount,
      nextRetryAt,
      persistent: Boolean(isSameFiles && retryCount >= 2),
      hasHashMismatch: Boolean(hasHashMismatch),
      quotaExceeded: Boolean(hasQuotaExceeded),
    };
  }

  // ── Finalise: snapshot last, then mark the staged record complete ────────
  await writeSnapshot(next, {
    version: manifest.version,
    files,
  });

  await setStaged({
    ...staged,
    retryCount: 0,
    failedFiles: [],
    failedDetails: {},
    nextRetryAt: null,
    complete: true,
    evict,
    clearRuntime: forceRefetch,
  });

  logger.log(
    `[NLPWA] Staged v${manifest.version}: ${stats.fetched} fetched, ${stats.copied} copied, ` +
    `${stats.reused} reused`
  );

  return { status: 'ready', failed: [], ...stats, estimatedDeltaBytes };
}
