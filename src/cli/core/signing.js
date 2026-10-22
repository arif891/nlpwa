import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { getManifestSignPayload } from '../../shared/crypto.js';

/**
 * Parse private key from PKCS8 PEM, base64, buffer, or KeyObject.
 *
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKeyInput
 * @returns {import('node:crypto').KeyObject|null}
 */
export function parsePrivateKey(privateKeyInput) {
  if (!privateKeyInput) return null;
  if (typeof privateKeyInput === 'object' && privateKeyInput.type === 'private') {
    return privateKeyInput;
  }
  if (typeof privateKeyInput === 'string' && privateKeyInput.includes('-----BEGIN PRIVATE KEY-----')) {
    return createPrivateKey(privateKeyInput);
  }
  if (typeof privateKeyInput === 'string') {
    const trimmed = privateKeyInput.trim();
    try {
      const der = Buffer.from(trimmed, 'base64');
      return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch {
      return createPrivateKey(trimmed);
    }
  }
  return createPrivateKey(privateKeyInput);
}

/**
 * Derive raw 32-byte Ed25519 public key (base64) from private key input.
 *
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKeyInput
 * @returns {string} Raw 32-byte Ed25519 public key encoded in Base64
 */
export function derivePublicKey(privateKeyInput) {
  try {
    const privKey = parsePrivateKey(privateKeyInput);
    if (!privKey) return '';
    const pubKey = createPublicKey(privKey);
    const spkiDer = pubKey.export({ type: 'spki', format: 'der' });
    const rawPubDer = spkiDer.subarray(-32);
    return rawPubDer.toString('base64');
  } catch {
    return '';
  }
}

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

  const keyObj = parsePrivateKey(privateKeyInput);
  if (!keyObj) return '';

  const sigBuffer = sign(null, dataBuffer, keyObj);
  return sigBuffer.toString('base64');
}

/**
 * Async sign helper alias.
 */
export async function signManifest(manifest, privateKeyInput) {
  return signManifestSync(manifest, privateKeyInput);
}

