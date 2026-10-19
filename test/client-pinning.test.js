import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { commitStaged, commitIfReady } from '../src/sw/update/commit.js';
import { handleFetch } from '../src/sw/fetch/index.js';
import {
  getActive,
  getActiveName,
  pinClient,
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getAllPinnedCaches,
  pruneClientPins,
  cleanupCaches,
} from '../src/sw/cache/store.js';
import { getFromOffline } from '../src/sw/cache/offline/store.js';
import { handleMessage } from '../src/sw/events/message.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

const cfg = (extra = {}) => JSON.stringify({
  routes: [{ match: '**', strategy: 'cache-first' }],
  precache: ['/app.js', '/config.json', '/index.html'],
  ...extra,
});

const asNavigation = (r, resultingClientId = 'new-tab') => new Proxy(r, {
  get: (t, k) => {
    if (k === 'mode') return 'navigate';
    if (k === 'resultingClientId') return resultingClientId;
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
  },
});

test('client pinning: navigation fetch event pins resultingClientId to the active cache', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const activeV1 = (await getActive()).cache;

  let responded;
  const navEvent = {
    request: asNavigation(req('/'), 'tab-alpha'),
    resultingClientId: 'tab-alpha',
    respondWith: (p) => { responded = p; },
    waitUntil() {},
  };

  handleFetch(navEvent);
  await responded;

  assert.equal(getClientPinnedCache('tab-alpha'), activeV1, 'tab-alpha should be pinned to active cache v1');
});

test('client pinning: open tab running old code is served old unhashed files after another tab commits a new version', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1 content',
    '/index.html': '<html>v1</html>',
  });
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  const v1Cache = (await getActive()).cache;

  // 1. Tab A navigates to v1 and is pinned to v1Cache
  let respondedA;
  handleFetch({
    request: asNavigation(req('/'), 'tab-A'),
    resultingClientId: 'tab-A',
    respondWith: (p) => { respondedA = p; },
    waitUntil() {},
  });
  await respondedA;
  assert.equal(getClientPinnedCache('tab-A'), v1Cache);

  // 2. A new version 1.0.1 is deployed and staged
  server.set('1.0.1', {
    '/config.json': cfg(),
    '/app.js': 'app v2 content',
    '/index.html': '<html>v2</html>',
  });
  const manifest = await (await server.fetch(req('/api/update/info.json'))).json();
  const stageRes = await stageUpdate(manifest);
  assert.equal(stageRes.status, 'ready');

  // 3. Tab B opens and commits version 1.0.1 on navigation
  let respondedB;
  handleFetch({
    request: asNavigation(req('/'), 'tab-B'),
    resultingClientId: 'tab-B',
    respondWith: (p) => { respondedB = p; },
    waitUntil() {},
  });
  await respondedB;

  const v2Cache = (await getActive()).cache;
  assert.notEqual(v2Cache, v1Cache, 'active cache should have updated to v2');
  assert.equal(getClientPinnedCache('tab-B'), v2Cache, 'tab-B should be pinned to v2');
  assert.equal(getClientPinnedCache('tab-A'), v1Cache, 'tab-A should still be pinned to v1');

  // 4. Tab A (still running v1) fetches unhashed /app.js
  let appResponseA;
  handleFetch({
    request: req('/app.js'),
    clientId: 'tab-A',
    respondWith: (p) => { appResponseA = p; },
    waitUntil() {},
  });
  const textA = await (await appResponseA).text();
  assert.equal(textA, 'app v1 content', 'Tab A must receive v1 unhashed JS despite v2 being globally active');

  // 5. Tab B fetches unhashed /app.js
  let appResponseB;
  handleFetch({
    request: req('/app.js'),
    clientId: 'tab-B',
    respondWith: (p) => { appResponseB = p; },
    waitUntil() {},
  });
  const textB = await (await appResponseB).text();
  assert.equal(textB, 'app v2 content', 'Tab B must receive v2 unhashed JS');
});

test('client pinning: pinned caches are preserved during cleanupCaches while client tabs are open', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1',
  });
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  const v1Cache = (await getActive()).cache;

  // Pin a tab to v1
  pinClient('tab-persistent', v1Cache);

  // Deploy and commit v2
  server.set('1.0.1', { '/config.json': cfg(), '/app.js': 'app v2' });
  const m1 = await (await server.fetch(req('/api/update/info.json'))).json();
  await stageUpdate(m1);
  await commitStaged();
  const v2Cache = (await getActive()).cache;

  // Deploy and commit v3
  server.set('1.0.2', { '/config.json': cfg(), '/app.js': 'app v3' });
  const m2 = await (await server.fetch(req('/api/update/info.json'))).json();
  await stageUpdate(m2);
  await commitStaged();
  const v3Cache = (await getActive()).cache;

  // Check which caches exist in CacheStorage
  const storedNames = await caches.keys();
  assert.ok(storedNames.includes(v3Cache), 'v3 active cache should exist');
  assert.ok(storedNames.includes(v1Cache), 'v1 pinned cache must NOT be evicted while tab-persistent is open');

  // When tab-persistent closes (unpinned), subsequent cleanup can prune v1
  unpinClient('tab-persistent');
  await cleanupCaches({
    base: 'offline',
    runtime: 'runtime',
    keep: [v3Cache, (await getActive()).previousCache, ...getAllPinnedCaches()],
  });

  const afterCloseNames = await caches.keys();
  assert.equal(afterCloseNames.includes(v1Cache), false, 'v1 cache is safely evicted once no tab is pinned to it');
});

test('client pinning: pruneClientPins drops pins for clients no longer in self.clients', async () => {
  const server = makeServer('1.0.0', { '/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);
  await precacheFiles();

  pinClient('client-alive', 'offline@1.0.0-1');
  pinClient('client-closed', 'offline@1.0.0-1');

  // Mock self.clients returning only client-alive
  globalThis.self.clients = {
    matchAll: async () => [{ id: 'client-alive' }],
  };

  await pruneClientPins();

  assert.equal(getClientPinnedCache('client-alive'), 'offline@1.0.0-1');
  assert.equal(getClientPinnedCache('client-closed'), null, 'closed client pin should be pruned');
});

test('client pinning: stores and returns full content-hash or prerelease pinnedVersion without truncation', async () => {
  const server = makeServer('1.0.0-a1b2c3d4e5f6', { '/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);
  await precacheFiles();

  // Pin a client to a full content-hash version
  pinClient('tab-content-hash', 'offline@1.0.0-a1b2c3d4e5f6-m1q7', '1.0.0-a1b2c3d4e5f6');
  assert.equal(getClientPinnedVersion('tab-content-hash'), '1.0.0-a1b2c3d4e5f6');

  // Query via GET_VERSION message handler
  const handler = handleMessage({ version: '1', caches: { offline: 'offline' } });
  let replyData = null;
  const event = {
    data: { type: MESSAGE_TYPES.GET_VERSION },
    source: { id: 'tab-content-hash' },
    ports: [{ postMessage: (msg) => { replyData = msg.data; } }],
    waitUntil: (p) => p,
  };

  handler(event);
  await new Promise(r => setTimeout(r, 10));

  assert.ok(replyData);
  assert.equal(replyData.pinnedVersion, '1.0.0-a1b2c3d4e5f6', 'pinnedVersion must not be truncated to 1.0.0');
});

test('client pinning: getFromOffline falls back to active cache if pinned cache is missing/evicted', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app active v1',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  // Pin a client to a cache name that does NOT exist in CacheStorage
  pinClient('tab-evicted', 'offline@non-existent-cache', '0.9.0');

  // getFromOffline must safely check cacheExists and fall back to the active cache without throwing or creating an empty cache
  const hit = await getFromOffline('/app.js', {}, 'tab-evicted');
  assert.ok(hit, 'Must successfully hit in active cache');
  assert.equal(await hit.text(), 'app active v1');

  // CacheStorage must not contain a zombie empty cache
  const storedKeys = await caches.keys();
  assert.equal(storedKeys.includes('offline@non-existent-cache'), false);
});
