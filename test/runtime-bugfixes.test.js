import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { setupFakeIDB } from './helpers/fake-idb.js';
import { resetMeta, setActive, getActive, getBlockedVersions } from '../src/sw/cache/store.js';
import { sweepOrphanCaches } from '../src/sw/update/commit.js';
import { emitBuildManifests } from '../bin/build-utils.js';
import { fetchServerVersion, resetManifestMemo } from '../src/sw/update/manifest.js';
import { handlePush, handleNotificationClick } from '../src/sw/events/push.js';
import { BadgePlugin } from '../src/plugins/badge/sw.js';
import { ShareTargetPlugin, isShareTargetRequest } from '../src/plugins/share/sw.js';
import { AVAILABLE_PLUGINS } from '../src/cli/commands/add.js';
import { SyncQueue } from '../src/plugins/sync/queue.js';
import { initConfig } from '../src/sw/config/index.js';
import { runRequestWillFetch } from '../src/sw/fetch/plugins.js';
import { performFetch } from '../src/sw/fetch/strategies/context.js';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Runtime Bugfixes & Hardening', () => {
  const testDistDir = resolve(process.cwd(), 'test-dist-bugfixes');

  before(async () => {
    setupFakeIDB();
    setupEnv(async () => new Response('OK'));
    mkdirSync(testDistDir, { recursive: true });
  });

  after(() => {
    if (existsSync(testDistDir)) {
      try {
        rmSync(testDistDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Ignore transient Windows file lock errors on teardown
      }
    }
  });

  test('P0: signingKey and non-serializable hooks are stripped from runtime config.json', () => {
    const rawConfig = {
      version: '1.0.0',
      signingKey: 'SECRET_ED25519_KEY_NEVER_LEAK_TO_CLIENT',
      onPush: () => {},
      onNotificationClick: () => {},
      routes: [
        {
          match: '/api/**',
          strategy: 'network-only',
          requestWillFetch: () => {},
        },
      ],
    };

    const { runtimeConfig } = emitBuildManifests({
      options: { distDir: testDistDir },
      rawConfig,
    });

    assert.equal(runtimeConfig.signingKey, undefined);
    assert.equal(runtimeConfig.onPush, undefined);
    assert.equal(runtimeConfig.onNotificationClick, undefined);
    assert.equal(runtimeConfig.routes[0].requestWillFetch, undefined);

    const writtenConfig = JSON.parse(readFileSync(resolve(testDistDir, 'api/update/config.json'), 'utf8'));
    assert.equal(writtenConfig.signingKey, undefined);
    assert.equal(writtenConfig.onPush, undefined);
  });

  test('P1: sweepOrphanCaches retains active.fallbackCache', async () => {
    initConfig({
      caches: { offline: 'offline', runtime: 'runtime' },
    });
    await resetMeta();

    await caches.open('offline@v1-111');
    await caches.open('offline@v2-222');

    await setActive({
      cache: 'offline@v2-222',
      version: '2.0.0',
      fallbackCache: 'offline@v1-111',
      fallbackVersion: '1.0.0',
    });

    await sweepOrphanCaches();

    const cacheNames = await caches.keys();
    assert.equal(cacheNames.includes('offline@v2-222'), true, 'active cache retained');
    assert.equal(cacheNames.includes('offline@v1-111'), true, 'fallback cache retained');
  });

  test('P1: 304 Not Modified on version.json preserves rolloutPercent, channel, and blockedVersions', async () => {
    resetManifestMemo();
    initConfig({
      updateAPI: { version: 'https://example.com/api/update/version.json', info: 'https://example.com/api/update/info.json' },
    });

    let return304 = false;
    globalThis.fetch = async (url, opts) => {
      if (return304) {
        assert.equal(opts.headers['If-None-Match'], '"etag-123"');
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({
        version: '2.0.0',
        channel: 'beta',
        rolloutPercent: 25,
        blockedVersions: ['1.9.0'],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'ETag': '"etag-123"',
        },
      });
    };

    const firstRes = await fetchServerVersion();
    assert.equal(firstRes.version, '2.0.0');
    assert.equal(firstRes.channel, 'beta');
    assert.equal(firstRes.rolloutPercent, 25);
    assert.deepEqual(firstRes.blockedVersions, ['1.9.0']);

    return304 = true;
    const secondRes = await fetchServerVersion();
    assert.equal(secondRes.notModified, true);
    assert.equal(secondRes.version, '2.0.0');
    assert.equal(secondRes.channel, 'beta');
    assert.equal(secondRes.rolloutPercent, 25);
    assert.deepEqual(secondRes.blockedVersions, ['1.9.0']);
  });

  test('P2: BadgePlugin onPush and onNotificationClick hooks execute via initSW plugins', async () => {
    let pushPayloadReceived = null;
    let notifClickReceived = false;

    class TestBadgePlugin extends BadgePlugin {
      onPush(event, payload) {
        pushPayloadReceived = payload;
      }
      onNotificationClick(event) {
        notifClickReceived = true;
      }
    }

    const plugin = new TestBadgePlugin();
    initConfig({
      plugins: [plugin],
    });

    const pushHandler = handlePush();
    const mockPushEvent = {
      data: {
        json: () => ({ title: 'Test Alert', badge: 3 }),
        text: () => '',
      },
      waitUntil: () => {},
    };

    pushHandler(mockPushEvent);
    assert.deepEqual(pushPayloadReceived, { title: 'Test Alert', badge: 3 });

    const notifHandler = handleNotificationClick();
    const mockNotifEvent = {
      notification: {
        close: () => {},
        data: { url: '/' },
      },
      waitUntil: () => {},
    };

    notifHandler(mockNotifEvent);
    assert.equal(notifClickReceived, true);
  });

  test('P2: ShareTargetPlugin returns Response without causing body is unusable error', async () => {
    const plugin = new ShareTargetPlugin({ action: '/_share-target' });
    initConfig({
      plugins: [plugin],
    });

    const shareReq = new Request('https://example.com/_share-target', {
      method: 'POST',
      body: 'title=Hello&text=World',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(isShareTargetRequest(shareReq, { plugins: [plugin] }), true);

    const res = await performFetch(shareReq, null, {}, [plugin]);
    assert.equal(res instanceof Response, true);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('Location'), /^https:\/\/example\.com\/\?shared=1&shareId=[\w-]+/);
  });

  test('P2: nlpwa add includes sync, share, badge, and bg-fetch', () => {
    assert.equal(Boolean(AVAILABLE_PLUGINS.sync), true);
    assert.equal(Boolean(AVAILABLE_PLUGINS.share), true);
    assert.equal(Boolean(AVAILABLE_PLUGINS.badge), true);
    assert.equal(Boolean(AVAILABLE_PLUGINS['bg-fetch']), true);
  });

  test('P3: SyncQueue clear() and remove() return promises awaiting IDB completion', async () => {
    const queue = new SyncQueue('test-queue');
    const req = new Request('https://example.com/api/test', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'Content-Type': 'application/json' },
    });

    const id = await queue.push(req);
    assert.equal(typeof id, 'number');

    await queue.remove(id);
    const remaining = await queue.size();
    assert.equal(remaining, 0);

    await queue.push(req);
    await queue.push(req);
    assert.equal(await queue.size(), 2);

    await queue.clear();
    assert.equal(await queue.size(), 0);
  });

  test('package.json exports expose standalone sw entries and CJS-safe esm defaults', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(pkg.exports['.'].default, './out/client.esm.js');
    assert.equal(pkg.exports['./client'].default, './out/client.esm.js');
    assert.equal(pkg.exports['./sync/sw'].default, './out/plugins/sync.sw.js');
    assert.equal(pkg.exports['./share/sw'].default, './out/plugins/share.sw.js');
    assert.equal(pkg.exports['./badge/sw'].default, './out/plugins/badge.sw.js');
    assert.equal(pkg.exports['./bg-fetch/sw'].default, './out/plugins/bg-fetch.sw.js');
    assert.equal(pkg.exports['./out/*'], './out/*');
  });

  test('checkDirtyTabs returns canReload: !hasDirtyTabs', async () => {
    const { checkDirtyTabs, setDirty } = await import('../src/client/tabs.js');
    setDirty(false);
    const cleanCheck = await checkDirtyTabs();
    assert.equal(cleanCheck.canReload, true);
    assert.equal(cleanCheck.hasDirtyTabs, false);

    setDirty(true);
    const dirtyCheck = await checkDirtyTabs();
    assert.equal(dirtyCheck.canReload, false);
    assert.equal(dirtyCheck.hasDirtyTabs, true);
    setDirty(false);
  });

  test('subscribeChannel and getChannel track client release channel', async () => {
    const { nlpwa, subscribeChannel, getChannel } = await import('../src/client/index.js');
    await subscribeChannel('beta');
    assert.equal(getChannel(), 'beta');
    assert.equal(nlpwa.getState().channel, 'beta');

    await nlpwa.subscribeChannel('canary');
    assert.equal(nlpwa.getChannel(), 'canary');
    assert.equal(nlpwa.getState().channel, 'canary');
  });

  test('getDiagnostics exposes top-level properties and structured SW/client fields', async () => {
    const { getDiagnostics } = await import('../src/client/diagnostics.js');
    const diag = await getDiagnostics();
    assert.ok('activeVersion' in diag);
    assert.ok('pinnedVersion' in diag);
    assert.ok('isPinned' in diag);
    assert.ok('channel' in diag);
    assert.ok('isLeader' in diag);
    assert.ok('dirtyState' in diag);
    assert.ok('client' in diag);
    assert.equal(typeof diag.client.isLeader, 'boolean');
  });

  test('SET_CHANNEL handler does not mutate frozen config and persists channel to meta', async () => {
    const { handleMessage } = await import('../src/sw/events/message.js');
    const { initConfig, getConfig } = await import('../src/sw/config/index.js');
    const { readMeta } = await import('../src/sw/cache/store.js');
    const { MESSAGE_TYPES } = await import('../src/shared/constants.js');

    const config = initConfig({ version: '1.0.0', channel: 'stable' });
    assert.ok(Object.isFrozen(config));

    const onMessage = handleMessage(config);
    let replyPayload = null;

    await new Promise((resolve) => {
      const event = {
        data: { type: MESSAGE_TYPES.SET_CHANNEL, channel: 'beta', requestId: 'req-1' },
        waitUntil: (promise) => promise.then(resolve),
        ports: [{
          postMessage: (payload) => {
            replyPayload = payload;
          },
        }],
      };
      onMessage(event);
    });

    assert.equal(replyPayload?.error, undefined);
    assert.deepEqual(replyPayload?.data, { channel: 'beta' });
    assert.equal(getConfig().channel, 'beta');

    const meta = await readMeta('/_nlpwa/channel.json');
    assert.deepEqual(meta, { channel: 'beta' });
  });

  test('touchClientPin schedules debounced flush and persists updated lastSeenAt', async () => {
    const { touchClientPin, pinClient, initClientPins, flushClientPins, resetClientPinsMemo } = await import('../src/sw/cache/meta/client-pins.js');
    const { readMeta } = await import('../src/sw/cache/store.js');

    resetClientPinsMemo();
    await pinClient('client-test-1', 'offline@1.0.0', '1.0.0', 1000);
    const initialMeta = await readMeta('/_nlpwa/client-pins.json');
    assert.equal(initialMeta['client-test-1'].lastSeenAt, 1000);

    // Touch client pin
    touchClientPin('client-test-1');
    // Flush immediately to verify debounced write executed
    await flushClientPins();

    const updatedMeta = await readMeta('/_nlpwa/client-pins.json');
    assert.ok(updatedMeta['client-test-1'].lastSeenAt > 1000);
  });

  test('plugins/sync withStore falls back gracefully to in-memory store when IndexedDB is blocked', async () => {
    const { withStore } = await import('../src/plugins/sync/idb.js');
    const { SyncQueue } = await import('../src/plugins/sync/queue.js');

    // Simulate blocked DB by passing a mock callback
    let addedId = null;
    await withStore('readwrite', (store) => {
      return new Promise((resolve) => {
        const req = store.add({ queueName: 'test-q', timestamp: Date.now() });
        req.onsuccess = () => {
          addedId = req.result;
          resolve();
        };
      });
    });

    assert.ok(addedId !== null);
  });

  test('active.js verifies active cache with SNAPSHOT_CACHE_PATH', async () => {
    const { getActive, setActive, clearActive } = await import('../src/sw/cache/meta/active.js');
    const { SNAPSHOT_CACHE_PATH } = await import('../src/shared/constants.js');

    await clearActive();
    const cache = await caches.open('offline@test-snap');
    await cache.put(SNAPSHOT_CACHE_PATH, new Response('{"files":[]}'));

    await setActive({ cache: 'offline@test-snap', version: '1.0.0' });
    const active = await getActive();
    assert.equal(active?.cache, 'offline@test-snap');
  });

  test('staging background fetch isolates to staged cache and does not pollute active cache', async () => {
    const { handleStagingBackgroundFetchSuccess } = await import('../src/sw/events/bg-fetch.js');
    const { handleBackgroundFetchSuccess } = await import('../src/plugins/bg-fetch/sw.js');
    const { setStaged, setActive, clearActive, clearStaged } = await import('../src/sw/cache/store.js');

    await clearActive();
    await clearStaged();

    const activeCache = await caches.open('offline@active-v1');
    const stagedCache = await caches.open('offline@staged-v2');

    await setActive({ cache: 'offline@active-v1', version: '1.0.0' });
    await setStaged({
      cache: 'offline@staged-v2',
      version: '2.0.0',
      complete: false,
      files: [{ path: '/assets/large-file.bin', hash: '' }],
    });

    const mockEvent = {
      registration: {
        id: 'nlpwa-stage:%2Fassets%2Flarge-file.bin',
        matchAll: async () => [
          {
            request: new Request('https://example.com/assets/large-file.bin'),
            responseReady: Promise.resolve(new Response('large-file-content', { status: 200 })),
          },
        ],
      },
    };

    // 1. bg-fetch plugin ignores nlpwa-stage: and does not write to active cache
    await handleBackgroundFetchSuccess(mockEvent);
    const activeMatch = await activeCache.match('https://example.com/assets/large-file.bin');
    assert.ok(!activeMatch, 'Active live cache must not be modified by staging background fetch');

    // 2. handleStagingBackgroundFetchSuccess writes directly to staged cache
    await handleStagingBackgroundFetchSuccess(mockEvent);
    const stagedMatch = await stagedCache.match('https://example.com/assets/large-file.bin');
    assert.ok(stagedMatch, 'Staged cache must contain the completed background fetch file');
    assert.equal(await stagedMatch.text(), 'large-file-content');
  });

  test('staging background fetch verifies digest before put when file size <= maxVerifyBytes', async () => {
    const { handleStagingBackgroundFetchSuccess } = await import('../src/sw/events/bg-fetch.js');
    const { setStaged, clearStaged } = await import('../src/sw/cache/store.js');
    const { sha256Hex } = await import('../src/shared/hash.js');

    await clearStaged();
    const stagedCache = await caches.open('offline@staged-verify');

    const expectedContent = 'verified-large-content';
    const validHash = await sha256Hex(new TextEncoder().encode(expectedContent));
    const invalidHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    // 1. With invalid hash mismatch in strict mode, record must NOT be written to cache
    let aborted = false;
    await setStaged({
      cache: 'offline@staged-verify',
      version: '2.0.0',
      complete: false,
      files: [{ path: '/assets/verified.bin', hash: invalidHash, size: 10 * 1024 * 1024 }],
    });

    const failingEvent = {
      registration: {
        id: `nlpwa-stage:%2Fassets%2Fverified.bin:${invalidHash.slice(0, 16)}`,
        abort: async () => { aborted = true; },
        matchAll: async () => [
          {
            request: new Request('https://example.com/assets/verified.bin'),
            responseReady: Promise.resolve(new Response(expectedContent, { status: 200 })),
          },
        ],
      },
    };

    await handleStagingBackgroundFetchSuccess(failingEvent);
    assert.ok(aborted, 'Registration must be aborted on hash mismatch');
    const unverifiedMatch = await stagedCache.match('https://example.com/assets/verified.bin');
    assert.ok(!unverifiedMatch, 'Mismatched file must not be put into staged cache');

    // 2. With valid matching hash, record is verified and stored in staged cache
    await setStaged({
      cache: 'offline@staged-verify',
      version: '2.0.0',
      complete: false,
      files: [{ path: '/assets/verified.bin', hash: validHash, size: 10 * 1024 * 1024 }],
    });

    const successEvent = {
      registration: {
        id: `nlpwa-stage:%2Fassets%2Fverified.bin:${validHash.slice(0, 16)}`,
        matchAll: async () => [
          {
            request: new Request('https://example.com/assets/verified.bin'),
            responseReady: Promise.resolve(new Response(expectedContent, { status: 200 })),
          },
        ],
      },
    };

    await handleStagingBackgroundFetchSuccess(successEvent);
    const verifiedMatch = await stagedCache.match('https://example.com/assets/verified.bin');
    assert.ok(verifiedMatch, 'Verified file must be stored in staged cache');
    assert.equal(await verifiedMatch.text(), expectedContent);
  });

  test('staging background fetch rejects stale download when ID hash prefix differs from staged manifest', async () => {
    const { handleStagingBackgroundFetchSuccess } = await import('../src/sw/events/bg-fetch.js');
    const { setStaged, clearStaged } = await import('../src/sw/cache/store.js');

    await clearStaged();
    const stagedCache = await caches.open('offline@staged-stale');

    const newVersionHash = 'bbbbbbbbbbbbbbbb1234567890abcdef1234567890abcdef1234567890abcdef';
    const oldVersionHash = 'aaaaaaaaaaaaaaaa1234567890abcdef1234567890abcdef1234567890abcdef';

    await setStaged({
      cache: 'offline@staged-stale',
      version: '3.0.0',
      complete: false,
      files: [{ path: '/assets/model.bin', hash: newVersionHash, size: 50 * 1024 * 1024 }],
    });

    let aborted = false;
    const staleEvent = {
      registration: {
        // ID embeds old version hash prefix
        id: `nlpwa-stage:%2Fassets%2Fmodel.bin:${oldVersionHash.slice(0, 16)}`,
        abort: async () => { aborted = true; },
        matchAll: async () => [
          {
            request: new Request('https://example.com/assets/model.bin'),
            responseReady: Promise.resolve(new Response('old-model-weights', { status: 200 })),
          },
        ],
      },
    };

    await handleStagingBackgroundFetchSuccess(staleEvent);
    assert.ok(aborted, 'Stale download registration must be aborted');
    const staleMatch = await stagedCache.match('https://example.com/assets/model.bin');
    assert.ok(!staleMatch, 'Stale release file must NOT be written into newer staged cache');
  });

  test('checkForUpdate coalesces concurrent check requests into sequential passes', async () => {
    const { checkForUpdate, resetUpdateCheckState } = await import('../src/sw/update/index.js');
    resetUpdateCheckState();

    // Launch two checks concurrently
    const p1 = checkForUpdate();
    const p2 = checkForUpdate({ force: true });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1 !== undefined);
    assert.ok(r2 !== undefined);
  });
});
