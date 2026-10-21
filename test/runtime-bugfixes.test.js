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
      rmSync(testDistDir, { recursive: true, force: true });
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
    assert.equal(res.headers.get('Location'), 'https://example.com/?shared=1');
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
});
