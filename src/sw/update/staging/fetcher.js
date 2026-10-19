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
  allowOversizedUnverified = false,
} = {}) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(30000)
    : undefined;
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  if (expected && verify !== false) {
    const size = fileSize ?? Number(response.headers?.get?.('content-length') || response.headers?.get?.('x-nlpwa-content-length') || 0);
    if (maxVerifyBytes > 0 && size > maxVerifyBytes) {
      if (allowOversizedUnverified || verify === 'warn') {
        logger.warn(
          `[NLPWA] ${path}: File size (${(size / (1024 * 1024)).toFixed(1)} MB) exceeds maxVerifyBytes threshold ` +
          `(${(maxVerifyBytes / (1024 * 1024)).toFixed(1)} MB). Skipping in-memory hash verification (opt-in allowOversizedUnverified).`
        );
        return response;
      }
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
