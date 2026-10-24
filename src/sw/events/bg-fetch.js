import { getStaged } from '../cache/store.js';
import { checkForUpdate } from '../update/index.js';
import { logger } from '../logger.js';
import { getConfig } from '../config/index.js';
import { sha256Hex, hashMatches } from '../../shared/hash.js';
import { resolvePathWithBase } from '../../shared/url.js';

/**
 * Handle browser 'backgroundfetchsuccess' event for OTA staging downloads.
 * Verifies that downloaded records match the active staged manifest and
 * expected hash/size before storing them into the staged cache partition,
 * preventing unverified or stale writes across releases.
 *
 * @param {BackgroundFetchEvent} event
 */
export async function handleStagingBackgroundFetchSuccess(event) {
  const bgFetch = event?.registration;
  if (!bgFetch || !bgFetch.id?.startsWith('nlpwa-stage:')) return;

  try {
    const idBody = bgFetch.id.slice('nlpwa-stage:'.length);
    const lastColon = idBody.lastIndexOf(':');
    let targetPath = '';
    let idHashPrefix = '';
    if (lastColon !== -1) {
      targetPath = decodeURIComponent(idBody.slice(0, lastColon));
      idHashPrefix = idBody.slice(lastColon + 1);
    } else {
      targetPath = decodeURIComponent(idBody);
    }

    const staged = await getStaged();
    if (!staged || !staged.cache) {
      logger.warn('[NLPWA] Staging Background Fetch completed but no staged cache found:', bgFetch.id);
      await bgFetch.abort?.().catch(() => {});
      return;
    }

    const config = getConfig();
    const stagedFiles = staged.files || [];

    // Look up expected file entry in current staged manifest
    const targetFile = stagedFiles.find((f) => {
      if (f.path === targetPath) return true;
      if (resolvePathWithBase(f.path, config.base) === targetPath) return true;
      try {
        const u = new URL(targetPath, 'http://localhost');
        if (f.path === u.pathname || resolvePathWithBase(f.path, config.base) === u.pathname) return true;
      } catch {}
      return false;
    });

    // If file is not in current staged manifest, download is stale across releases
    if (!targetFile) {
      logger.warn(`[NLPWA] Background Fetch completed for ${targetPath}, but file is not in current staged manifest. Discarding.`);
      await bgFetch.abort?.().catch(() => {});
      return;
    }

    // Verify registration ID hash prefix matches expected hash in manifest
    const expectedHash = targetFile.hash || '';
    if (idHashPrefix && expectedHash && !expectedHash.toLowerCase().startsWith(idHashPrefix.toLowerCase())) {
      logger.warn(
        `[NLPWA] Background Fetch completed with stale hash prefix (${idHashPrefix}) for ${targetPath}; staged manifest expects ${expectedHash}. Discarding.`
      );
      await bgFetch.abort?.().catch(() => {});
      return;
    }

    const verify = config.verifyHashes ?? (config.publicKey ? 'strict' : 'warn');
    const maxVerifyBytes = config.maxVerifyBytes ?? (25 * 1024 * 1024);
    const allowOversizedUnverified = config.allowOversizedUnverified ?? true;
    const skipVerify = Boolean(targetFile.skipVerify);

    const records = await bgFetch.matchAll();
    if (!records || records.length === 0) return;

    const cache = await caches.open(staged.cache);

    for (const record of records) {
      const response = await record.responseReady;
      if (!response || !response.ok) continue;

      // Soft-404 / Captive portal check
      const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
      const lowerPath = targetPath.toLowerCase();
      const isCodeOrAsset = /\.(js|mjs|cjs|css|json|wasm)$/.test(lowerPath.split('?')[0]);
      if (isCodeOrAsset && contentType.includes('text/html')) {
        logger.warn(`[NLPWA] Soft-404 / captive portal detected for Background Fetch asset ${targetPath}. Discarding.`);
        await bgFetch.abort?.().catch(() => {});
        return;
      }

      const size = targetFile.size ?? Number(
        response.headers?.get?.('content-length') || response.headers?.get?.('x-nlpwa-content-length') || 0
      );

      if (expectedHash && verify !== false && !skipVerify) {
        const isOversized = (maxVerifyBytes > 0 && size > maxVerifyBytes);
        if (isOversized) {
          if (!allowOversizedUnverified && verify === 'strict') {
            logger.error(
              `[NLPWA] Background Fetch ${targetPath}: size (${(size / (1024 * 1024)).toFixed(1)} MB) exceeds maxVerifyBytes in strict mode. Discarding.`
            );
            await bgFetch.abort?.().catch(() => {});
            return;
          }
          logger.warn(
            `[NLPWA] ${targetPath}: File size exceeds maxVerifyBytes threshold. Storing without in-memory hash verification.`
          );
        } else {
          // File is under maxVerifyBytes: verify its digest before put
          const actual = await sha256Hex(await response.clone().arrayBuffer());
          if (!hashMatches(actual, expectedHash)) {
            const detail = `hash mismatch (expected ${expectedHash}, got ${actual.slice(0, expectedHash.length)})`;
            logger.error(`[NLPWA] Background Fetch ${targetPath} hash verification failed: ${detail}. Discarding.`);
            await bgFetch.abort?.().catch(() => {});
            return;
          }
        }
      }

      await cache.put(record.request, response);
      logger.log(`[NLPWA] Stored verified Background Fetch record in staged cache (${staged.cache}):`, record.request.url || record.request);
    }

    await checkForUpdate({ force: true });
  } catch (err) {
    logger.warn('[NLPWA] Error handling staging background fetch completion:', err?.message || err);
  }
}

