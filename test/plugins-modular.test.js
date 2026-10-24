import test from 'node:test';
import assert from 'node:assert/strict';

// Share plugin
import {
  ShareTargetPlugin,
  isShareTargetRequest,
  handleShareTarget,
  getLatestSharedData,
  SHARE_CACHE_NAME,
  ShareTargetClient,
  shareTargetClient,
} from '../src/plugins/share/index.js';

// Badge plugin
import {
  BadgePlugin,
  clearBadgeOnNotificationClick,
  setBadgeFromPush,
  isBadgingSupported,
  setAppBadge,
  clearAppBadge,
  BadgeClient,
  badgeClient,
} from '../src/plugins/badge/index.js';

// Bg-fetch plugin
import {
  BackgroundFetchPlugin,
  handleBackgroundFetchSuccess,
  handleBackgroundFetchFail,
  handleBackgroundFetchAbort,
  BackgroundFetchClient,
  backgroundFetchClient,
  BG_FETCH_CACHE_NAME,
  getBgFetchIdForUrl,
  getUrlFromBgFetchId,
} from '../src/plugins/bg-fetch/index.js';

// Crypto plugin
import {
  getManifestSignPayload,
  decodePublicKey,
  verifyManifestSignature,
} from '../src/plugins/crypto/index.js';

import { signManifestSync } from '../src/cli/core/signing.js';
import crypto from 'node:crypto';

test('share plugin: ShareTargetPlugin intercepts share requests and stores data', async () => {
  const plugin = new ShareTargetPlugin({ action: '/share-post', redirectUrl: '/app?shared=1' });
  const req = new Request('http://localhost:3000/share-post?title=TestTitle&text=TestText');

  assert.equal(isShareTargetRequest(req, { shareTarget: { action: '/share-post' } }), true);
  assert.equal(isShareTargetRequest(new Request('http://localhost:3000/other'), { shareTarget: { action: '/share-post' } }), false);

  // Plugin array detection via explicit flag (immune to minified constructor.name)
  assert.equal(isShareTargetRequest(req, { plugins: [plugin] }), true);
  assert.equal(plugin.isShareTargetPlugin, true, 'ShareTargetPlugin must have isShareTargetPlugin flag');

  // Must NOT falsely match an arbitrary third-party plugin having an action option
  const arbitraryPlugin = { options: { action: '/share-post' } };
  assert.equal(isShareTargetRequest(req, { plugins: [arbitraryPlugin] }), false, 'Must not falsely match unrelated plugin with action option');

  // Mock cache
  const stored = new Map();
  const mockCache = {
    async put(request, response) {
      const url = typeof request === 'string' ? request : request.url;
      stored.set(url, response);
    },
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      return stored.get(url) || null;
    },
    async delete(request) {
      const url = typeof request === 'string' ? request : request.url;
      return stored.delete(url);
    },
  };
  globalThis.caches = {
    open: async (name) => mockCache,
  };

  const response = await plugin.requestWillFetch({
    request: req,
    event: { request: req },
  });

  assert.ok(response instanceof Response);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location'), /^http:\/\/localhost:3000\/app\?shared=1&shareId=[\w-]+/);

  // Verify getLatestSharedData consumes from queue
  const latest = await getLatestSharedData();
  assert.ok(latest);
  assert.equal(latest.title, 'TestTitle');
  assert.equal(latest.text, 'TestText');

  assert.ok(shareTargetClient instanceof ShareTargetClient);
});

test('badge plugin: BadgePlugin and client methods manipulate app badge', async () => {
  let badgeVal = null;
  let cleared = false;

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      setAppBadge: async (num) => { badgeVal = num; },
      clearAppBadge: async () => { cleared = true; badgeVal = 0; },
    },
    configurable: true,
    writable: true,
  });

  assert.equal(isBadgingSupported(), true);

  await setAppBadge(5);
  assert.equal(badgeVal, 5);

  await clearAppBadge();
  assert.equal(cleared, true);
  assert.equal(badgeVal, 0);

  // Test BadgePlugin SW hooks
  const plugin = new BadgePlugin({ clearOnClick: true });

  cleared = false;
  plugin.onNotificationClick({
    waitUntil: (p) => p,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cleared, true);

  // Push payload
  plugin.onPush({ waitUntil: (p) => p }, { badge: 12 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(badgeVal, 12);

  assert.ok(badgeClient instanceof BadgeClient);
});

test('bg-fetch plugin: BackgroundFetchPlugin handles success and persists records', async () => {
  const cachedRecords = new Map();
  const mockCache = {
    async put(request, response) {
      const url = typeof request === 'string' ? request : request.url;
      cachedRecords.set(url, response);
    },
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      return cachedRecords.get(url) || null;
    },
  };
  globalThis.caches = {
    open: async () => mockCache,
  };

  const broadcasted = [];
  globalThis.self = {
    clients: {
      matchAll: async () => [{
        postMessage: (msg) => broadcasted.push(msg),
      }],
    },
  };

  const event = {
    registration: {
      id: 'download-ai-weights',
      matchAll: async () => [
        {
          request: new Request('http://localhost:3000/models/weights.bin'),
          responseReady: Promise.resolve(new Response('binary weights data', { status: 200 })),
        },
      ],
    },
  };

  await handleBackgroundFetchSuccess(event);

  assert.equal(cachedRecords.has('http://localhost:3000/models/weights.bin'), true);
  assert.equal(broadcasted.length, 1);
  assert.equal(broadcasted[0].id, 'download-ai-weights');
  assert.equal(broadcasted[0].count, 1);
  assert.equal(broadcasted[0].cacheName, 'runtime');

  // Test route-aware targeting: custom cacheName in routes
  const customCaches = new Map();
  globalThis.caches = {
    open: async (name) => {
      if (!customCaches.has(name)) {
        customCaches.set(name, new Map());
      }
      const store = customCaches.get(name);
      return {
        async put(request, response) {
          const url = typeof request === 'string' ? request : request.url;
          store.set(url, response);
        },
      };
    },
  };

  const routeEvent = {
    registration: {
      id: 'download-video',
      matchAll: async () => [
        {
          request: new Request('http://localhost:3000/media/intro.mp4'),
          responseReady: Promise.resolve(new Response('video mp4 data', { status: 200 })),
        },
      ],
    },
  };

  const mockConfig = {
    routes: [
      { match: '/media/**', strategy: 'cache-first', cacheName: 'videos-cache' },
    ],
  };

  await handleBackgroundFetchSuccess(routeEvent, { config: mockConfig });
  assert.equal(customCaches.has('videos-cache'), true);
  assert.equal(customCaches.get('videos-cache').has('http://localhost:3000/media/intro.mp4'), true);

  // Test background upload handling (POST request with JSON reply)
  const uploadEvent = {
    registration: {
      id: 'upload-logs',
      matchAll: async () => [
        {
          request: new Request('http://localhost:3000/api/upload', { method: 'POST' }),
          responseReady: Promise.resolve(new Response(JSON.stringify({ uploaded: true, id: 'log-123' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })),
        },
      ],
    },
  };

  let updateUICalledWith = null;
  uploadEvent.updateUI = async (ui) => {
    updateUICalledWith = ui;
  };

  await handleBackgroundFetchSuccess(uploadEvent);
  assert.equal(broadcasted.length, 3);
  assert.equal(broadcasted[2].id, 'upload-logs');
  assert.equal(broadcasted[2].isUpload, true);
  assert.deepEqual(broadcasted[2].uploadResults[0].response, { uploaded: true, id: 'log-123' });
  assert.equal(updateUICalledWith?.title, 'Upload complete');

  // Test fail event with updateUI
  let failUICalledWith = null;
  await handleBackgroundFetchFail({
    registration: {
      id: 'download-fail-task',
      failureReason: 'quota-exceeded',
    },
    updateUI: async (ui) => {
      failUICalledWith = ui;
    },
  });
  assert.equal(broadcasted.length, 4);
  assert.equal(broadcasted[3].failureReason, 'quota-exceeded');
  assert.equal(failUICalledWith?.title, 'Transfer failed');

  // Test abort event
  await handleBackgroundFetchAbort({
    registration: { id: 'download-abort-task' },
  });
  assert.equal(broadcasted.length, 5);
  assert.equal(broadcasted[4].id, 'download-abort-task');

  // Test deterministic ID helpers
  const expectedId = 'nlpwa-bg:%2Fassets%2Fweights.bin';
  assert.equal(getBgFetchIdForUrl('/assets/weights.bin'), expectedId);
  assert.equal(getUrlFromBgFetchId(expectedId), '/assets/weights.bin');
  assert.equal(getUrlFromBgFetchId('custom-id'), null);

  // Test client progress tracking
  let progressReport = null;
  const mockReg = {
    id: 'test-progress-reg',
    downloaded: 50,
    downloadTotal: 100,
    uploaded: 0,
    uploadTotal: 0,
    addEventListener(event, fn) {
      this._fn = fn;
    },
  };
  const unsub = await backgroundFetchClient.onProgress(mockReg, (p) => {
    progressReport = p;
  });
  assert.deepEqual(progressReport, {
    id: 'test-progress-reg',
    downloaded: 50,
    downloadTotal: 100,
    uploaded: 0,
    uploadTotal: 0,
    percent: 50,
  });
  unsub();

  // Test client.fetch with custom ID and multiple URLs
  let bgFetchMockCalls = [];
  globalThis.navigator = {
    serviceWorker: {
      ready: Promise.resolve({
        backgroundFetch: {
          async fetch(id, requests, opts) {
            bgFetchMockCalls.push({ id, requests, opts });
            return { id, ...opts };
          },
        },
      }),
    },
  };

  // 1. Custom ID with multiple URLs
  await backgroundFetchClient.fetch('album-01', ['/audio/track1.mp3', '/audio/track2.mp3'], {
    title: 'Downloading Album',
    downloadTotal: 10000,
  });
  assert.equal(bgFetchMockCalls.length, 1);
  assert.equal(bgFetchMockCalls[0].id, 'album-01');
  assert.deepEqual(bgFetchMockCalls[0].requests, ['/audio/track1.mp3', '/audio/track2.mp3']);
  assert.equal(bgFetchMockCalls[0].opts.title, 'Downloading Album');

  // 2. Omitted ID with single URL -> generates deterministic escaped URL ID
  await backgroundFetchClient.fetch('/models/large-model.onnx', { downloadTotal: 50000 });
  assert.equal(bgFetchMockCalls.length, 2);
  assert.equal(bgFetchMockCalls[1].id, 'nlpwa-bg:%2Fmodels%2Flarge-model.onnx');
  assert.deepEqual(bgFetchMockCalls[1].requests, ['/models/large-model.onnx']);

  // 3. Omitted ID with multiple URLs -> generates nlpwa-bg: timestamp ID
  await backgroundFetchClient.fetch(['/f1.bin', '/f2.bin'], { downloadTotal: 2000 });
  assert.equal(bgFetchMockCalls.length, 3);
  assert.ok(bgFetchMockCalls[2].id.startsWith('nlpwa-bg:'));
  assert.deepEqual(bgFetchMockCalls[2].requests, ['/f1.bin', '/f2.bin']);

  assert.ok(backgroundFetchClient instanceof BackgroundFetchClient);
});

test('crypto plugin: verifies Ed25519 manifest payloads', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    version: '2.0.0',
    files: [
      { path: '/app.js', hash: 'abc1234', size: 100 },
      { path: '/index.html', hash: 'def5678', size: 50 },
    ],
  };

  const signature = signManifestSync(manifest, privateKey);
  assert.ok(signature);
  const signed = { ...manifest, signature };

  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' });
  const isValid = await verifyManifestSignature(signed, spkiPem);
  assert.equal(isValid, true, 'Crypto plugin verifyManifestSignature validates valid signature');

  // Tampered payload
  const tampered = { ...signed, version: '2.0.1' };
  const isInvalid = await verifyManifestSignature(tampered, spkiPem);
  assert.equal(isInvalid, false, 'Crypto plugin rejects tampered signature');
});

test('bg-fetch plugin: does not call clone.blob() when Content-Length is missing', async () => {
  const cachedRecords = new Map();
  globalThis.caches = {
    open: async () => ({
      put: async (req, res) => {
        const url = typeof req === 'string' ? req : req.url;
        cachedRecords.set(url, res);
      },
    }),
  };

  globalThis.self = {
    clients: {
      matchAll: async () => [],
    },
  };

  let blobCalled = false;
  const mockResponse = new Response('chunked-large-stream', {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' }, // NO Content-Length
  });

  // Track if .blob() is ever called on the response or any clone
  const origBlob = mockResponse.blob;
  mockResponse.blob = async function () {
    blobCalled = true;
    return origBlob.apply(this, arguments);
  };

  const origClone = mockResponse.clone;
  mockResponse.clone = function () {
    const cl = origClone.apply(this, arguments);
    cl.blob = async function () {
      blobCalled = true;
      return origBlob.apply(this, arguments);
    };
    return cl;
  };

  const event = {
    registration: {
      id: 'no-content-length-task',
      downloaded: 1024 * 1024 * 50, // 50MB downloaded reported by browser
      matchAll: async () => [
        {
          request: new Request('http://localhost:3000/media/stream.bin'),
          responseReady: Promise.resolve(mockResponse),
        },
      ],
    },
  };

  await handleBackgroundFetchSuccess(event);

  assert.equal(blobCalled, false, 'Must not call clone.blob() to inspect size or buffer download into memory');
  assert.equal(cachedRecords.has('http://localhost:3000/media/stream.bin'), true, 'Persisted directly to cache storage');
});

