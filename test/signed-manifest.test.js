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
import { writeMeta, readMeta, setStaged, getStaged, getActive } from '../src/sw/cache/meta/index.js';

test('keys:generate CLI command outputs valid Ed25519 keys', async () => {
  const keys = await cmdGenerateKeys({ writeEnv: false });
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

  // 2. Server provides valid signed manifest without sequence -> rejected with SEQUENCE_REQUIRED
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
  const noSeqResult = await checkForUpdate();
  assert.equal(noSeqResult.updated, false);
  assert.equal(noSeqResult.errorCode, 'SEQUENCE_REQUIRED');

  // 3. Server provides valid signed manifest with numeric sequence -> accepted and staged!
  server.sequence = 100;
  server.signature = signManifestSync(
    {
      version: '2.0.0',
      sequence: 100,
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

test('update check: untrusted Tier 1 version.json does not freeze updates or fake rollout', async () => {
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
  server.sequence = 10;
  fakeSelf();

  setupEnv(server.fetch, { publicKey: pubKeyBase64 });
  await precacheFiles();

  // Attack scenario: Attacker/CDN serves untrusted unsigned version.json with version='1.0.0' or rolloutPercent=0
  // but Tier 2 has legitimate signed v2.0.0 with sequence=20
  server.set('2.0.0', v2Files);
  server.sequence = 20;

  // Untrusted Tier 1 tries to claim version is current v1.0.0 with rolloutPercent: 0
  server.versionSignature = null; // Unsigned!
  // Force version.json to return version='1.0.0' and rolloutPercent=0
  const origFetch = server.fetch;
  server.fetch = async (r) => {
    const url = new URL(r.url);
    if (url.pathname === '/api/update/version' || url.pathname === '/api/update/version.json') {
      return Response.json({
        version: '1.0.0', // Claims up to date
        rolloutPercent: 0, // Claims 0% rollout
        signature: 'invalid_sig',
      });
    }
    return origFetch(r);
  };

  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      sequence: 20,
      files: filesList,
    },
    privateKey
  );

  // checkForUpdate must NOT be fooled by the untrusted Tier 1 response; it must fall back to Tier 2 and update!
  const res = await checkForUpdate();
  assert.equal(res.updated, true, 'Should successfully update from signed Tier 2 manifest');
  assert.equal(res.version, '2.0.0');
});

test('update check: Tier 2 manifest enforces rolloutPercent limit', async () => {
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
  server.sequence = 10;
  fakeSelf();

  setupEnv(server.fetch, { publicKey: pubKeyBase64 });
  await precacheFiles();

  // Tier 1 endpoint returns 404 to force Tier 2 lookup
  const origFetch = server.fetch;
  server.fetch = async (r) => {
    const url = new URL(r.url);
    if (url.pathname === '/api/update/version' || url.pathname === '/api/update/version.json') {
      return new Response('not found', { status: 404 });
    }
    return origFetch(r);
  };

  server.set('2.0.0', v2Files);
  server.sequence = 20;
  server.rolloutPercent = 0; // 0% rollout! All cohorts excluded

  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      sequence: 20,
      rolloutPercent: 0,
      files: filesList,
    },
    privateKey
  );

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.rolloutExcluded, true);
});

test('update check: Tier 1 sequence replay rejection falls back to Tier 2', async () => {
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
  server.sequence = 100;
  fakeSelf();

  setupEnv(server.fetch, { publicKey: pubKeyBase64 });
  await precacheFiles();

  // Record that current client sequence is 100
  await writeMeta('/_nlpwa/sequence.json', { sequence: 100, version: '1.0.0' });

  // Attacker attempts to replay an older signed version.json with sequence: 50, version: '1.0.0'
  server.set('2.0.0', v2Files);
  server.sequence = 200; // Tier 2 has valid fresh sequence 200

  const origFetch = server.fetch;
  server.fetch = async (r) => {
    const url = new URL(r.url);
    if (url.pathname === '/api/update/version' || url.pathname === '/api/update/version.json') {
      const replayedTier1 = {
        version: '1.0.0',
        sequence: 50, // Replayed sequence! Lower than recorded 100
        blockedVersions: [],
      };
      const sig = signManifestSync(replayedTier1, privateKey);
      return Response.json({ ...replayedTier1, signature: sig });
    }
    return origFetch(r);
  };

  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      sequence: 200,
      files: filesList,
    },
    privateKey
  );

  const res = await checkForUpdate();
  // Must discard replayed Tier 1, proceed to Tier 2, and update to 2.0.0
  assert.equal(res.updated, true, 'Should discard replayed Tier 1 and update via Tier 2');
  assert.equal(res.version, '2.0.0');

  // Sequence must be updated to 200
  const seq = await readMeta('/_nlpwa/sequence.json');
  assert.equal(seq.sequence, 200);
});

test('update check: discardStaged handles fresh install with null active without throwing', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const v1Files = {
    '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
    '/app.js': 'app v1',
  };

  const server = makeServer('1.0.0', v1Files);
  server.sequence = 100;
  fakeSelf();

  setupEnv(server.fetch, { publicKey: pubKeyBase64 });
  // Do NOT call precacheFiles(); active is null (fresh install / interrupted install)
  assert.equal(await getActive(), null);

  // Simulate an interrupted initial install leaving an incomplete staged record
  await setStaged({
    version: '1.0.0',
    cache: 'offline@1.0.0-1',
    complete: false,
    stagedAt: Date.now(),
  });

  // Server serves an invalid / untrusted signature
  server.signature = 'invalid_signature_bytes';

  // checkForUpdate() previously crashed with:
  // TypeError: Cannot read properties of null (reading 'version') at discardStaged
  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'SIGNATURE_VERIFICATION_FAILED');

  // Staged record must have been discarded cleanly
  assert.equal(await getStaged(), null);
});


