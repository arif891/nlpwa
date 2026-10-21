import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer, fakeSelf, hash8 } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import {
  getManifestSignPayload,
  verifyManifestSignature,
  decodePublicKey,
} from '../src/shared/crypto.js';
import { signManifestSync } from '../src/cli/core/signing.js';
import { cmdGenerateKeys } from '../src/cli/commands/keys.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

test('keys:generate CLI command outputs valid Ed25519 keys', async () => {
  const keys = await cmdGenerateKeys({});
  assert.ok(keys.privateKeyBase64);
  assert.ok(keys.publicKeyBase64);
  assert.equal(keys.publicKeyBase64.length, 44); // 32 raw bytes base64 encoded
  assert.equal(keys.publicKeyHex.length, 64);    // 32 raw bytes hex encoded
  assert.ok(keys.spkiPem.includes('-----BEGIN PUBLIC KEY-----'));
});

test('crypto: decodePublicKey handles SPKI PEM, base64, and hex strings', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawDer = spkiDer.subarray(-32);

  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' });
  const rawBase64 = rawDer.toString('base64');
  const rawHex = rawDer.toString('hex');

  const decodedPem = decodePublicKey(spkiPem);
  assert.equal(decodedPem.byteLength, 44);

  const decodedBase64 = decodePublicKey(rawBase64);
  assert.equal(decodedBase64.byteLength, 32);

  const decodedHex = decodePublicKey(rawHex);
  assert.equal(decodedHex.byteLength, 32);
});

test('crypto: sign and verify manifest with Ed25519', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPubBase64 = spkiDer.subarray(-32).toString('base64');

  const manifest = {
    version: '1.2.0',
    files: [
      { path: '/b.js', hash: 'bbb', size: 200 },
      { path: '/a.js', hash: 'aaa', size: 100 },
    ],
  };

  const sig = signManifestSync(manifest, privateKey);
  assert.ok(sig);

  const signedManifest = { ...manifest, signature: sig };

  // Verification succeeds with raw base64 public key
  const valid = await verifyManifestSignature(signedManifest, rawPubBase64);
  assert.equal(valid, true);

  // Verification succeeds with SPKI PEM public key
  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' });
  const validPem = await verifyManifestSignature(signedManifest, spkiPem);
  assert.equal(validPem, true);

  // Tampering with manifest version causes verification to fail
  const tamperedManifest1 = { ...signedManifest, version: '1.2.1' };
  assert.equal(await verifyManifestSignature(tamperedManifest1, rawPubBase64), false);

  // Tampering with file hash causes verification to fail
  const tamperedManifest2 = {
    ...signedManifest,
    files: [{ path: '/a.js', hash: 'tampered', size: 100 }, { path: '/b.js', hash: 'bbb', size: 200 }],
  };
  assert.equal(await verifyManifestSignature(tamperedManifest2, rawPubBase64), false);

  // Missing signature returns false
  assert.equal(await verifyManifestSignature(manifest, rawPubBase64), false);
});

test('update check: enforces Ed25519 signature when config.publicKey is configured', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const v1Files = {
    '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
    '/app.js': 'app v1',
  };

  const v2Files = {
    '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
    '/app.js': 'app v2',
  };

  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();

  // Configure SW with public key
  setupEnv(server.fetch, { publicKey: pubKeyBase64 });

  await precacheFiles();

  // 1. Server offers v2.0.0 without signature -> rejected!
  server.set('2.0.0', v2Files);
  messages.length = 0;

  const unsignedResult = await checkForUpdate();
  assert.equal(unsignedResult.updated, false);
  assert.equal(unsignedResult.errorCode, 'SIGNATURE_VERIFICATION_FAILED');

  const failedMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_FAILED);
  assert.ok(failedMsg);
  assert.equal(failedMsg.errorCode, 'SIGNATURE_VERIFICATION_FAILED');

  // 2. Server provides valid signed manifest -> accepted and staged!
  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      files: filesList,
    },
    privateKey
  );

  messages.length = 0;
  const signedResult = await checkForUpdate();
  assert.equal(signedResult.updated, true);
  assert.equal(signedResult.version, '2.0.0');

  const readyMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_READY);
  assert.ok(readyMsg);
});
