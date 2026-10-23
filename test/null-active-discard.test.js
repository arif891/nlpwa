import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer, fakeSelf, hash8 } from './helpers/fake-server.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { signManifestSync } from '../src/cli/core/signing.js';
import {
  setStaged,
  getStaged,
  getActive,
  writeMeta,
  blockVersion,
} from '../src/sw/cache/meta/index.js';

const v1Files = {
  '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
  '/app.js': 'app v1',
};

const v2Files = {
  '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
  '/app.js': 'app v2',
};

test('null-active: discardStaged on Tier 1 target version blocked with active === null', async () => {
  const server = makeServer('1.0.0', v1Files);
  server.set('2.0.0', v2Files);
  fakeSelf();
  setupEnv(server.fetch);

  assert.equal(await getActive(), null, 'active must be null on fresh/interrupted install');

  // Staged update left behind by interrupted staging
  const stagedCache = 'offline@2.0.0-staged-1';
  await caches.open(stagedCache);
  await setStaged({ version: '2.0.0', cache: stagedCache, complete: false });

  // Block the server target version
  await blockVersion('2.0.0');

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.blocked, true);
  assert.equal(res.version, '2.0.0');

  // Staged record and cache must be discarded without null-active crash
  assert.equal(await getStaged(), null);
  const cacheKeys = await caches.keys();
  assert.equal(cacheKeys.includes(stagedCache), false);
});

test('null-active: discardStaged on Tier 2 signature verification failure with active === null', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch, { publicKey: pubKeyBase64 });

  assert.equal(await getActive(), null);

  const stagedCache = 'offline@1.0.0-staged-sig';
  await caches.open(stagedCache);
  await setStaged({ version: '1.0.0', cache: stagedCache, complete: false });

  // Untrusted signature
  server.signature = 'bad_signature_bytes';

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'SIGNATURE_VERIFICATION_FAILED');

  assert.equal(await getStaged(), null);
  const cacheKeys = await caches.keys();
  assert.equal(cacheKeys.includes(stagedCache), false);
});

test('null-active: discardStaged on Tier 2 missing sequence in crypto mode with active === null', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const server = makeServer('1.0.0', v1Files);
  server.set('2.0.0', v2Files);
  fakeSelf();
  setupEnv(server.fetch, { publicKey: pubKeyBase64 });

  assert.equal(await getActive(), null);

  const stagedCache = 'offline@2.0.0-staged-seqreq';
  await caches.open(stagedCache);
  await setStaged({ version: '2.0.0', cache: stagedCache, complete: false });

  // Manifest without sequence
  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      // sequence omitted
      files: filesList,
    },
    privateKey
  );

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'SEQUENCE_REQUIRED');

  assert.equal(await getStaged(), null);
  const cacheKeys = await caches.keys();
  assert.equal(cacheKeys.includes(stagedCache), false);
});

test('null-active: discardStaged on Tier 2 sequence replay with active === null', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const server = makeServer('1.0.0', v1Files);
  server.set('2.0.0', v2Files);
  server.sequence = 50; // Older than recorded sequence 100
  fakeSelf();
  setupEnv(server.fetch, { publicKey: pubKeyBase64 });

  assert.equal(await getActive(), null);

  // Client sequence is already at 100
  await writeMeta('/_nlpwa/sequence.json', { sequence: 100, version: '1.0.0' });

  const stagedCache = 'offline@2.0.0-staged-replay';
  await caches.open(stagedCache);
  await setStaged({ version: '2.0.0', cache: stagedCache, complete: false });

  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
  }));

  server.signature = signManifestSync(
    {
      version: '2.0.0',
      sequence: 50,
      files: filesList,
    },
    privateKey
  );

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'REPLAY_DETECTED');

  assert.equal(await getStaged(), null);
  const cacheKeys = await caches.keys();
  assert.equal(cacheKeys.includes(stagedCache), false);
});

test('null-active: discardStaged on Tier 2 manifest version blocked with active === null', async () => {
  const server = makeServer('1.0.0', v1Files);
  // Force 404 on Tier 1 to hit Tier 2
  const origFetch = server.fetch;
  server.fetch = async (r) => {
    const url = new URL(r.url);
    if (url.pathname === '/api/update/version' || url.pathname === '/api/update/version.json') {
      return new Response('not found', { status: 404 });
    }
    return origFetch(r);
  };
  server.set('2.0.0', v2Files);
  fakeSelf();
  setupEnv(server.fetch);

  assert.equal(await getActive(), null);

  const stagedCache = 'offline@2.0.0-staged-blocked';
  await caches.open(stagedCache);
  await setStaged({ version: '2.0.0', cache: stagedCache, complete: false });

  // Block version 2.0.0
  await blockVersion('2.0.0');

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.blocked, true);
  assert.equal(res.version, '2.0.0');

  assert.equal(await getStaged(), null);
  const cacheKeys = await caches.keys();
  assert.equal(cacheKeys.includes(stagedCache), false);
});
