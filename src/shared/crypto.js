/**
 * Canonical Ed25519 manifest payload generation and verification.
 * Works across both Node.js (CLI / build) and browser Service Workers via Web Crypto.
 */

/**
 * Generate a deterministic canonical JSON string of the manifest payload for signing and verification.
 *
 * @param {Object} manifest - The manifest object containing version and files
 * @returns {string} Canonical JSON string
 */
export function getManifestSignPayload(manifest) {
  if (!manifest || typeof manifest !== 'object') return '';

  const canonicalObj = {
    version: String(manifest.version || ''),
  };

  if (manifest.sequence !== undefined && manifest.sequence !== null) {
    canonicalObj.sequence = Number(manifest.sequence) || 0;
  }
  if (manifest.timestamp !== undefined && manifest.timestamp !== null) {
    canonicalObj.timestamp = Number(manifest.timestamp) || 0;
  }
  if (manifest.minVersion !== undefined && manifest.minVersion !== null) {
    canonicalObj.minVersion = String(manifest.minVersion);
  }
  if (Array.isArray(manifest.blockedVersions)) {
    canonicalObj.blockedVersions = [...manifest.blockedVersions].map(String).sort();
  }
  if (manifest.channel !== undefined && manifest.channel !== null) {
    canonicalObj.channel = String(manifest.channel);
  }
  if (manifest.rolloutPercent !== undefined && manifest.rolloutPercent !== null) {
    canonicalObj.rolloutPercent = Number(manifest.rolloutPercent) || 0;
  }

  if (Array.isArray(manifest.files)) {
    canonicalObj.files = [...manifest.files]
      .filter((f) => f && typeof f.path === 'string')
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        path: f.path,
        hash: f.hash || '',
        size: typeof f.size === 'number' ? f.size : 0,
        skipVerify: Boolean(f.skipVerify),
      }));
  }

  return JSON.stringify(canonicalObj);
}

/**
 * Decode a public key string (SPKI PEM, Base64, or Hex) into an ArrayBuffer / Uint8Array.
 *
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {Uint8Array}
 */
export function decodePublicKey(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input !== 'string') {
    throw new TypeError('[NLPWA] Public key must be a string or buffer.');
  }

  const trimmed = input.trim();

  // 1. SPKI PEM format: -----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----
  if (trimmed.includes('-----BEGIN PUBLIC KEY-----')) {
    const b64 = trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    return decodeBase64(b64);
  }

  // 2. 64-character Hex string (32 raw bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // 3. Base64 string
  return decodeBase64(trimmed);
}

function decodeBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
  // Node.js fallback
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  throw new Error('[NLPWA] Base64 decoder unavailable.');
}

/**
 * Verify an Ed25519 signature on an update manifest using the Web Crypto API.
 * Compatible with modern browsers, Service Workers, and Node.js 18+.
 *
 * @param {Object} manifest - The manifest object with signature
 * @param {string|Uint8Array|ArrayBuffer} publicKeyInput - Public key (SPKI PEM, Base64, or Hex)
 * @returns {Promise<boolean>} True if signature is cryptographically valid
 */
export async function verifyManifestSignature(manifest, publicKeyInput) {
  if (!manifest || !manifest.signature) return false;
  if (!publicKeyInput) return false;

  const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : null;
  if (!cryptoSubtle || typeof cryptoSubtle.importKey !== 'function') {
    throw new Error('[NLPWA] Web Crypto API (crypto.subtle) is not available.');
  }

  const keyBytes = decodePublicKey(publicKeyInput);
  const isSpki = keyBytes.byteLength === 44;
  const isRaw = keyBytes.byteLength === 32;

  if (!isSpki && !isRaw) {
    throw new Error(
      `[NLPWA] Invalid Ed25519 public key length (${keyBytes.byteLength} bytes). Expected 32 raw bytes or 44 SPKI bytes.`
    );
  }

  const cryptoKey = await cryptoSubtle.importKey(
    isSpki ? 'spki' : 'raw',
    keyBytes,
    { name: 'Ed25519' },
    false,
    ['verify']
  );

  const canonicalPayload = getManifestSignPayload(manifest);
  const dataBytes = new TextEncoder().encode(canonicalPayload);
  const sigBytes = decodeBase64(manifest.signature);

  return await cryptoSubtle.verify(
    { name: 'Ed25519' },
    cryptoKey,
    sigBytes,
    dataBytes
  );
}
