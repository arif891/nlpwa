import { logger } from '../../logger.js';
import { sha256Hex, hashMatches } from '../../../shared/hash.js';
import { DEFAULT_STAGING_FETCH_TIMEOUT_MS } from '../../../shared/constants.js';

/**
 * Fetch a file fresh from the network and check it against its manifest hash.
 * If file size exceeds largeFileThresholdBytes (default: 25MB), attempts
 * delegation to Background Fetch (if supported) for native background downloading.
 *
 * @param {Object} params
 * @returns {Promise<Response>}
 */
export async function fetchVerified({
  path,
  expected,
  verify,
  maxVerifyBytes = 25 * 1024 * 1024,
  largeFileThresholdBytes = 25 * 1024 * 1024,
  fileSize = null,
  allowOversizedUnverified = true,
  skipVerify = false,
  timeoutMs = DEFAULT_STAGING_FETCH_TIMEOUT_MS,
} = {}) {
  let response = null;
  const isLarge = (fileSize && fileSize > largeFileThresholdBytes);

  // If file is large (>25MB) and backgroundFetch is supported, delegate to Background Fetch
  if (isLarge && typeof self !== 'undefined' && self.registration?.backgroundFetch) {
    try {
      const hashPart = expected ? `:${expected.slice(0, 16)}` : '';
      const bgId = `nlpwa-stage:${encodeURIComponent(path)}${hashPart}`;
      let bgRegistration = await self.registration.backgroundFetch.get(bgId);
      if (!bgRegistration) {
        bgRegistration = await self.registration.backgroundFetch.fetch(bgId, [path], {
          title: `Updating asset ${path}`,
          downloadTotal: fileSize,
        });
      }
      const record = await bgRegistration.match(path);
      if (record) {
        let timer = null;
        const bgRes = await Promise.race([
          record.responseReady,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Background Fetch timeout')), timeoutMs);
          }),
        ]).catch(() => null);
        if (timer) clearTimeout(timer);

        if (bgRes && bgRes.ok) {
          response = bgRes;
          logger.log(`[NLPWA] Downloaded ${path} via Background Fetch.`);
        } else if (bgRegistration.result === '' || !bgRegistration.result) {
          // The background download is still in progress natively in the browser/OS.
          // Do not fail or penalize update with failure backoff.
          const pendingErr = new Error(`Background Fetch download in progress for ${path}`);
          pendingErr.code = 'BACKGROUND_FETCH_PENDING';
          pendingErr.isBackgroundFetchPending = true;
          pendingErr.bgId = bgId;
          throw pendingErr;
        }
      }
    } catch (bgErr) {
      if (bgErr?.isBackgroundFetchPending) {
        throw bgErr;
      }
      logger.debug('[NLPWA] Background Fetch failed or unavailable; falling back to fetch():', bgErr?.message || bgErr);
    }
  }

  if (!response) {
    // Crucial: create a fresh AbortSignal with timeoutMs so the fallback fetch does not inherit an expired timer
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    response = await fetch(path, { cache: 'no-store', signal });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  // Soft-404 / Captive portal check:
  // If an HTML error/login page is returned for scripts, styles, json, or wasm, reject it regardless of hash verification mode!
  const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
  const lowerPath = path.toLowerCase();
  const isCodeOrAsset = /\.(js|mjs|cjs|css|json|wasm)$/.test(lowerPath.split('?')[0]);
  if (isCodeOrAsset && contentType.includes('text/html')) {
    throw new Error(`Soft-404 / Captive portal detected: HTTP 200 text/html returned for asset ${path}`);
  }

  const size = fileSize ?? Number(response.headers?.get?.('content-length') || response.headers?.get?.('x-nlpwa-content-length') || 0);

  if (expected && verify !== false) {
    if (skipVerify) {
      logger.warn(
        `[NLPWA] ${path}: marked skipVerify in manifest. Skipping in-memory hash verification; storing directly.`
      );
    } else {
      const isOversized = (maxVerifyBytes > 0 && size > maxVerifyBytes);
      if (isOversized) {
        if (allowOversizedUnverified || verify === 'warn') {
          const mb = (size / (1024 * 1024)).toFixed(1);
          const limitMb = (maxVerifyBytes / (1024 * 1024)).toFixed(1);
          logger.warn(
            `[NLPWA] ${path}: File size (${mb} MB) exceeds maxVerifyBytes threshold (${limitMb} MB). Skipping in-memory hash verification to prevent memory exhaustion; storing directly.`
          );
        } else {
          throw new Error(
            `File size (${(size / (1024 * 1024)).toFixed(1)} MB) exceeds maxVerifyBytes threshold (${(maxVerifyBytes / (1024 * 1024)).toFixed(1)} MB) in strict mode. Set allowOversizedUnverified: true or increase maxVerifyBytes.`
          );
        }
      } else {
        const actual = await sha256Hex(await response.clone().arrayBuffer());
        if (!hashMatches(actual, expected)) {
          const detail = `hash mismatch (expected ${expected}, got ${actual.slice(0, expected.length)})`;
          if (verify === 'strict') throw new Error(detail);
          logger.warn(`[NLPWA] ${path}: ${detail} - storing anyway (verifyHashes: 'warn')`);
        }
      }
    }
  }

  return response;
}
