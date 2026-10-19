import { logger } from '../../logger.js';
import { sha256Hex, hashMatches } from '../../../shared/hash.js';

/**
 * Fetch a file fresh from the network and check it against its manifest hash.
 *
 * @param {Object} params
 * @returns {Promise<Response>}
 */
export async function fetchVerified({
  path,
  expected,
  verify,
  maxVerifyBytes = 20 * 1024 * 1024,
  fileSize = null,
  allowOversizedUnverified = true,
  skipVerify = false,
} = {}) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(30000)
    : undefined;
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  if (expected && verify !== false) {
    const size = fileSize ?? Number(response.headers?.get?.('content-length') || response.headers?.get?.('x-nlpwa-content-length') || 0);
    if (skipVerify) {
      logger.warn(
        `[NLPWA] ${path}: marked skipVerify in manifest. Skipping in-memory hash verification; storing directly.`
      );
      return response;
    }

    const isOversized = (maxVerifyBytes > 0 && size > maxVerifyBytes);
    if (isOversized) {
      if (allowOversizedUnverified || verify === 'warn') {
        const mb = (size / (1024 * 1024)).toFixed(1);
        const limitMb = (maxVerifyBytes / (1024 * 1024)).toFixed(1);
        logger.warn(
          `[NLPWA] ${path}: File size (${mb} MB) exceeds maxVerifyBytes threshold (${limitMb} MB). Skipping in-memory hash verification to prevent memory exhaustion; storing directly.`
        );
        return response;
      }
      throw new Error(
        `File size (${(size / (1024 * 1024)).toFixed(1)} MB) exceeds maxVerifyBytes threshold (${(maxVerifyBytes / (1024 * 1024)).toFixed(1)} MB) in strict mode. Set allowOversizedUnverified: true or increase maxVerifyBytes.`
      );
    }
    const actual = await sha256Hex(await response.clone().arrayBuffer());
    if (!hashMatches(actual, expected)) {
      const detail = `hash mismatch (expected ${expected}, got ${actual.slice(0, expected.length)})`;
      if (verify === 'strict') throw new Error(detail);
      logger.warn(`[NLPWA] ${path}: ${detail} - storing anyway (verifyHashes: 'warn')`);
    }
  }
  return response;
}
