import { sign, createPrivateKey } from 'node:crypto';
import { getManifestSignPayload } from '../../shared/crypto.js';

/**
 * Synchronously sign an update manifest payload using Ed25519 (CLI / build pipeline).
 *
 * @param {Object} manifest - Manifest object
 * @param {string|Buffer} privateKeyInput - Private key in PKCS8 PEM or Base64 format
 * @returns {string} Base64 encoded Ed25519 signature
 */
export function signManifestSync(manifest, privateKeyInput) {
  if (!manifest || !privateKeyInput) return '';

  const canonicalPayload = getManifestSignPayload(manifest);
  const dataBuffer = Buffer.from(canonicalPayload, 'utf8');

  let keyObj;
  if (privateKeyInput && typeof privateKeyInput === 'object' && privateKeyInput.type === 'private') {
    keyObj = privateKeyInput;
  } else if (typeof privateKeyInput === 'string' && privateKeyInput.includes('-----BEGIN PRIVATE KEY-----')) {
    keyObj = createPrivateKey(privateKeyInput);
  } else if (typeof privateKeyInput === 'string') {
    const trimmed = privateKeyInput.trim();
    // Try base64 PKCS8 DER
    try {
      const der = Buffer.from(trimmed, 'base64');
      keyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch {
      keyObj = createPrivateKey(trimmed);
    }
  } else {
    keyObj = createPrivateKey(privateKeyInput);
  }

  const sigBuffer = sign(null, dataBuffer, keyObj);
  return sigBuffer.toString('base64');
}

/**
 * Async sign helper alias.
 */
export async function signManifest(manifest, privateKeyInput) {
  return signManifestSync(manifest, privateKeyInput);
}
