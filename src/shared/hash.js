/**
 * SHA-256 of a buffer as a lowercase hex string.
 * Works in Service Workers, browsers and Node 18+ (Web Crypto).
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<string>}
 */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare a full SHA-256 hex digest with a manifest hash.
 *
 * The CLI emits the first 32 hex characters (older builds emitted 8), so the
 * manifest hash is treated as a prefix. Anything shorter than 8 characters is rejected so a
 * truncated or empty hash can never "match" by accident.
 *
 * @param {string} actualHex  full digest from sha256Hex()
 * @param {string} expected   hash from the manifest (prefix of the digest)
 * @returns {boolean}
 */
export function hashMatches(actualHex, expected) {
  if (typeof expected !== 'string' || expected.length < 8) return false;
  return actualHex.startsWith(expected.toLowerCase());
}
