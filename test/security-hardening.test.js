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
} from '../src/shared/crypto.js';
import { signManifestSync } from '../src/cli/core/signing.js';
import { fetchVerified, fetchWithActivityTimeout } from '../src/sw/update/staging/fetcher.js';
import {
  syncBlockedVersions,
  isVersionBlocked,
  clearBlockedVersions,
  resetBlockedVersionsMemo,
} from '../src/sw/cache/meta/blocked-versions.js';
import { handleShareTarget } from '../src/plugins/share/sw.js';
import { initConfig, updateActiveConfig, getConfig } from '../src/sw/config/index.js';
import { writeMeta } from '../src/sw/cache/meta/store.js';

test('crypto: sign payload covers skipVerify, sequence, minVersion, blockedVersions, channel, rolloutPercent', () => {
  const m1 = {
    version: '1.0.0',
    sequence: 100,
    minVersion: '1.0.0',
    blockedVersions: ['0.9.0', '0.8.0'],
    channel: 'beta',
    rolloutPercent: 25,
    files: [
      { path: '/app.js', hash: 'abc', size: 10, skipVerify: false },
    ],
  };

  const payload1 = getManifestSignPayload(m1);
  const parsed1 = JSON.parse(payload1);

  assert.equal(parsed1.version, '1.0.0');
  assert.equal(parsed1.sequence, 100);
  assert.equal(parsed1.minVersion, '1.0.0');
  assert.deepEqual(parsed1.blockedVersions, ['0.8.0', '0.9.0']); // Sorted!
  assert.equal(parsed1.channel, 'beta');
  assert.equal(parsed1.rolloutPercent, 25);
  assert.equal(parsed1.files[0].skipVerify, false);

  // Modifying skipVerify to true alters the canonical string
  const m2 = {
    ...m1,
    files: [
      { path: '/app.js', hash: 'abc', size: 10, skipVerify: true },
    ],
  };
  const payload2 = getManifestSignPayload(m2);
  assert.notEqual(payload1, payload2);
});

test('crypto: adding skipVerify: true invalidates an existing signature', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyBase64 = spkiDer.subarray(-32).toString('base64');

  const manifest = {
    version: '1.0.0',
    files: [
      { path: '/app.js', hash: 'validhash', size: 100, skipVerify: false },
    ],
  };

  const signature = signManifestSync(manifest, privateKey);
  const signed = { ...manifest, signature };

  // Original verifies cleanly
  assert.equal(await verifyManifestSignature(signed, pubKeyBase64), true);

  // Attacker adds skipVerify: true under the same signature
  const tampered = {
    version: '1.0.0',
    signature,
    files: [
      { path: '/app.js', hash: 'validhash', size: 100, skipVerify: true },
    ],
  };

  assert.equal(await verifyManifestSignature(tampered, pubKeyBase64), false);
});

test('replay protection: rejects update manifest when sequence is older than stored sequence', async () => {
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
  setupEnv(server.fetch, { publicKey: pubKeyBase64 });

  await precacheFiles();

  // Simulate an already recorded newer sequence in storage
  await writeMeta('/_nlpwa/sequence.json', { sequence: 500 });

  // Server attempts to replay an older manifest with sequence 200
  server.set('2.0.0', v2Files);
  server.sequence = 200;
  const filesList = Object.entries(v2Files).map(([p, body]) => ({
    path: p,
    hash: hash8(body),
    size: Buffer.byteLength(String(body)),
    skipVerify: false,
  }));
  server.signature = signManifestSync(
    { version: '2.0.0', sequence: 200, files: filesList },
    privateKey
  );

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'REPLAY_DETECTED');
});

test('fetchWithActivityTimeout: aborts on header timeout if server does not respond in time', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, { signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason || new Error('Aborted'));
        });
      });
    };

    await assert.rejects(
      async () => {
        await fetchWithActivityTimeout('https://example.com/slow', {
          headerTimeoutMs: 50,
        });
      },
      /Header timeout/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchWithActivityTimeout: aborts on idle timeout if stream stalls mid-download', async () => {
  const origFetch = globalThis.fetch;
  try {
    let pullCount = 0;
    const stalledStream = new ReadableStream({
      async pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        }
        // After first chunk, stall indefinitely without closing or enqueuing
      },
    });

    globalThis.fetch = async () => new Response(stalledStream, { status: 200 });

    const res = await fetchWithActivityTimeout('https://example.com/stalling', {
      headerTimeoutMs: 1000,
      idleTimeoutMs: 50,
    });

    assert.equal(res.status, 200);

    const reader = res.body.getReader();
    const firstChunk = await reader.read();
    assert.deepEqual(Array.from(firstChunk.value), [1, 2, 3]);

    // Next read will wait for pull and hit idle timeout
    await assert.rejects(
      async () => {
        await reader.read();
      },
      /Idle timeout/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchWithActivityTimeout: completes successfully when chunks arrive steadily', async () => {
  const origFetch = globalThis.fetch;
  try {
    let chunksSent = 0;
    const steadyStream = new ReadableStream({
      async pull(controller) {
        if (chunksSent < 3) {
          chunksSent++;
          controller.enqueue(new Uint8Array([chunksSent]));
        } else {
          controller.close();
        }
      },
    });

    globalThis.fetch = async () => new Response(steadyStream, { status: 200 });

    const res = await fetchWithActivityTimeout('https://example.com/steady', {
      headerTimeoutMs: 500,
      idleTimeoutMs: 500,
    });

    assert.equal(res.status, 200);
    const body = await res.arrayBuffer();
    assert.deepEqual(Array.from(new Uint8Array(body)), [1, 2, 3]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('soft-404 guard: fetchVerified strictly rejects text/html response for script/asset chunks', async () => {
  // Simulate captive portal returning 200 OK with text/html for /app.js
  const htmlPortalResponse = new Response('<html><body>Login to WiFi</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

  globalThis.fetch = async () => htmlPortalResponse;

  await assert.rejects(
    async () => {
      await fetchVerified({
        path: '/app.js',
        expected: 'someexpectedhash',
        verify: 'warn', // Even in warn mode!
      });
    },
    /Soft-404 \/ Captive portal detected/
  );
});

test('remote unblocking: syncBlockedVersions reconciles and unblocks versions removed from server list', async () => {
  resetBlockedVersionsMemo();
  await clearBlockedVersions();

  // 1. Server initially blocks v1.0.1
  await syncBlockedVersions(['1.0.1', '1.0.2']);
  assert.equal(await isVersionBlocked('1.0.1'), true);
  assert.equal(await isVersionBlocked('1.0.2'), true);

  // 2. Admin fixes mistake, updates remote list to only block v1.0.2
  await syncBlockedVersions(['1.0.2']);

  // v1.0.1 is now UNBLOCKED!
  assert.equal(await isVersionBlocked('1.0.1'), false);
  assert.equal(await isVersionBlocked('1.0.2'), true);
});

test('share target: rejects cross-site form POSTs with 403 Forbidden', async () => {
  const req = new Request('https://example.com/_share-target', {
    method: 'POST',
    headers: {
      'Sec-Fetch-Site': 'cross-site',
    },
  });

  const res = await handleShareTarget({ request: req }, { shareTarget: { action: '/_share-target' } });
  assert.equal(res.status, 403);

  // Allowed when allowCrossSite: true
  const resAllowed = await handleShareTarget(
    { request: req },
    { shareTarget: { action: '/_share-target', allowCrossSite: true } }
  );
  // Returns redirect to redirectUrl
  assert.equal(resAllowed.status, 303);
});

test('updateActiveConfig locks publicKey, updateAPI, and telemetry against runtime config tampering', () => {
  initConfig({
    publicKey: 'original-public-key',
    updateAPI: { version: '/api/v', info: '/api/i' },
    telemetry: { url: '/api/report' },
  });

  // Untrusted runtime config tries to replace publicKey, updateAPI, and telemetry
  const updated = updateActiveConfig({
    publicKey: 'hacker-public-key',
    updateAPI: { version: 'https://evil.com/v', info: 'https://evil.com/i' },
    telemetry: { url: 'https://evil.com/telemetry' },
    routes: [{ match: '/test', strategy: 'cache-first' }],
  });

  assert.equal(updated.publicKey, 'original-public-key');
  assert.deepEqual(updated.updateAPI, { version: '/api/v', info: '/api/i' });
  assert.deepEqual(updated.telemetry, { url: '/api/report' });
});
