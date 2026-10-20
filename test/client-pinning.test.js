import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { fetchServerInfo } from '../src/sw/update/manifest.js';
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
  resetClientPinsMemo,
} from '../src/sw/cache/store.js';
import { getFromOffline } from '../src/sw/cache/offline/store.js';
import { handleMessage } from '../src/sw/events/message.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

const cfg = (extra = {}) => JSON.stringify({
  routes: [{ match: '**', strategy: 'cache-first' }],
  precache: ['/app.js', '/api/update/config.json', '/index.html'],
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
    '/api/update/config.json': cfg(),
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
    '/api/update/config.json': cfg(),
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
    '/api/update/config.json': cfg(),
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
    '/api/update/config.json': cfg(),
    '/app.js': 'app v1',
  });
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  const v1Cache = (await getActive()).cache;

  // Pin a tab to v1
  pinClient('tab-persistent', v1Cache);

  // Deploy and commit v2
  server.set('1.0.1', { '/api/update/config.json': cfg(), '/app.js': 'app v2' });
  const m1 = await (await server.fetch(req('/api/update/info.json'))).json();
  await stageUpdate(m1);
  await commitStaged();
  const v2Cache = (await getActive()).cache;

  // Deploy and commit v3
  server.set('1.0.2', { '/api/update/config.json': cfg(), '/app.js': 'app v3' });
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
  const server = makeServer('1.0.0', { '/api/update/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);
  await precacheFiles();

  pinClient('client-alive', 'offline@1.0.0-1');
  pinClient('client-closed', 'offline@1.0.0-1');

  // Mock self.clients returning only client-alive
  globalThis.self.clients = {
    matchAll: async () => [{ id: 'client-alive' }],
  };

  await pruneClientPins(0);

  assert.equal(getClientPinnedCache('client-alive'), 'offline@1.0.0-1');
  assert.equal(getClientPinnedCache('client-closed'), null, 'closed client pin should be pruned');
});

test('client pinning: stores and returns full content-hash or prerelease pinnedVersion without truncation', async () => {
  const server = makeServer('1.0.0-a1b2c3d4e5f6', { '/api/update/config.json': cfg(), '/app.js': 'app v1' });
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
    '/api/update/config.json': cfg(),
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

test('client pinning: commitStaged prunes dead client pins across updates so old offline caches are freed', async () => {
  const server = makeServer('1.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v1',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const v1Cache = (await getActive()).cache;

  // Pin two tabs to v1 with timestamp past grace period
  await pinClient('tab-closed-1', v1Cache, '1.0.0', Date.now() - 60000);
  await pinClient('tab-closed-2', v1Cache, '1.0.0', Date.now() - 60000);
  assert.ok(getAllPinnedCaches().includes(v1Cache));

  // Stage and commit v2
  server.set('2.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v2',
    '/index.html': '<html>v2</html>',
  });
  await stageUpdate(await fetchServerInfo());
  await commitStaged();

  // Both tabs have now closed: self.clients.matchAll returns no windows
  globalThis.self.clients = {
    matchAll: async () => [],
  };

  // Stage and commit v3
  server.set('3.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v3',
    '/index.html': '<html>v3</html>',
  });
  await stageUpdate(await fetchServerInfo());
  await commitStaged();

  // Pins for closed tabs must have been pruned by commitStaged
  assert.equal(getClientPinnedCache('tab-closed-1'), null);
  assert.equal(getClientPinnedCache('tab-closed-2'), null);
  assert.equal(getAllPinnedCaches().length, 0);

  // v1 cache is older than previousActive (which is v2) and no live clients pin it, so it MUST be freed!
  const currentCaches = await caches.keys();
  assert.equal(currentCaches.includes(v1Cache), false, 'v1 cache must be deleted after tabs close across updates');
});

test('client pinning: PIN_CLIENT message validates cacheName prefix', async () => {
  const server = makeServer('1.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v1',
  });
  setupEnv(server.fetch);
  await precacheFiles();
  const activeCache = (await getActive()).cache;

  const handler = handleMessage({ version: '1', caches: { offline: 'offline' } });

  // 1. Caller attempts to pin an invalid/arbitrary cache name
  let replyData = null;
  const event1 = {
    data: { type: MESSAGE_TYPES.PIN_CLIENT, cache: 'arbitrary-injected-cache' },
    source: { id: 'tab-attacker' },
    ports: [{ postMessage: (msg) => { replyData = msg.data; } }],
    waitUntil: (p) => p,
  };
  handler(event1);
  await new Promise(r => setTimeout(r, 10));

  assert.ok(replyData);
  assert.equal(replyData.cache, activeCache, 'Should reject arbitrary cache and fallback to active offline cache');
  assert.equal(getClientPinnedCache('tab-attacker'), activeCache);

  // 2. UNPIN_CLIENT message unpins client
  let unpinReply = null;
  const event2 = {
    data: { type: MESSAGE_TYPES.UNPIN_CLIENT },
    source: { id: 'tab-attacker' },
    ports: [{ postMessage: (msg) => { unpinReply = msg.data; } }],
    waitUntil: (p) => p,
  };
  handler(event2);
  await new Promise(r => setTimeout(r, 10));

  assert.ok(unpinReply);
  assert.equal(getClientPinnedCache('tab-attacker'), null, 'Client should be unpinned');
});

test('client pinning: pin is durable across SW restart before subresource fetch, preventing version skew', async () => {
  const server = makeServer('1.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v1',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  globalThis.self.clients = {
    matchAll: async () => [{ id: 'tab-persisted', postMessage: () => {} }],
  };
  await precacheFiles();

  const v1Active = await getActive();
  const v1Cache = v1Active.cache;

  // 1. Tab navigates to / (resultingClientId: 'tab-persisted')
  let responded;
  const waitUntilPromises = [];
  const navEvent = {
    request: asNavigation(req('/'), 'tab-persisted'),
    resultingClientId: 'tab-persisted',
    respondWith: (p) => { responded = p; },
    waitUntil: (p) => { waitUntilPromises.push(p); },
  };
  handleFetch(navEvent);
  await responded;
  await Promise.all(waitUntilPromises);

  // Verify tab was pinned in memory
  assert.equal(getClientPinnedCache('tab-persisted'), v1Cache);

  // 2. A new version 2.0.0 is deployed, staged, and committed
  server.set('2.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v2',
    '/index.html': '<html>v2</html>',
  });
  await stageUpdate(await fetchServerInfo());
  await commitStaged();

  const v2Active = await getActive();
  assert.equal(v2Active.version, '2.0.0');

  // 3. Simulate SW termination and restart:
  // Clear all in-memory memos (as happens when a Service Worker process is killed)
  resetClientPinsMemo();

  // In memory, pin is now null
  assert.equal(getClientPinnedCache('tab-persisted'), null);

  // 4. Tab makes a subresource fetch for /app.js (with clientId: 'tab-persisted')
  let subResponded;
  const subWaitUntil = [];
  const subEvent = {
    request: req('/app.js'),
    clientId: 'tab-persisted',
    respondWith: (p) => { subResponded = p; },
    waitUntil: (p) => { subWaitUntil.push(p); },
  };
  handleFetch(subEvent);
  const response = await subResponded;
  await Promise.all(subWaitUntil);

  // Because pin was persisted to disk immediately, SW reloaded it during initClientPins()
  // and served /app.js from v1Cache ('app v1'), NOT v2!
  assert.equal(await response.text(), 'app v1', 'Must serve app v1 from pinned cache, not app v2');
  assert.equal(getClientPinnedCache('tab-persisted'), v1Cache, 'Client must remain pinned to v1 cache');
});

test('client pinning: pruneClientPins honors grace period and does NOT drop newly navigating tabs', async () => {
  const server = makeServer('1.0.0', {
    '/api/update/config.json': cfg(),
    '/app.js': 'app v1',
  });
  setupEnv(server.fetch);
  await precacheFiles();
  const v1Cache = (await getActive()).cache;

  // Simulate a tab that navigated 2 seconds ago (still transitioning, not yet in matchAll)
  await pinClient('tab-transitioning', v1Cache, '1.0.0', Date.now() - 2000);

  // matchAll returns empty (browser hasn't exposed the window client yet)
  globalThis.self.clients = { matchAll: async () => [] };

  // Run pruneClientPins with default 30s grace period
  await pruneClientPins();

  // Pin must be PRESERVED due to grace period!
  assert.equal(getClientPinnedCache('tab-transitioning'), v1Cache, 'Must preserve pin within grace period');

  // Once grace period expires, pruning removes it
  await pruneClientPins(1000); // 1s grace period, pin is 2s old
  assert.equal(getClientPinnedCache('tab-transitioning'), null, 'Must prune pin once grace period has elapsed');
});

