import { sha256Hex, hashMatches } from '../../../shared/hash.js';

/**
 * Is `path` already in the staging cache with the expected content?
 *
 * @param {Object} params
 * @returns {Promise<boolean>}
 */
export async function isAlreadyStaged({
  cache,
  path,
  expected,
  verify,
  maxVerifyBytes = 25 * 1024 * 1024,
  fileSize = null,
  fetchUrl = path,
  allowOversizedUnverified = true,
  skipVerify = false,
} = {}) {
  const hit = (await cache.match(fetchUrl)) || (fetchUrl !== path ? await cache.match(path) : null);
  if (!hit) return false;
  if (!expected || verify === false) return true;
  const size = fileSize ?? Number(hit.headers?.get?.('content-length') || hit.headers?.get?.('x-nlpwa-content-length') || 0);
  if (skipVerify) return true;
  const isOversized = (maxVerifyBytes > 0 && size > maxVerifyBytes);
  if (isOversized) {
    if (allowOversizedUnverified || verify === 'warn') {
      return true;
    }
    return false;
  }
  return hashMatches(await sha256Hex(await hit.arrayBuffer()), expected);
}
