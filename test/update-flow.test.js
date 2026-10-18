import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { commitIfReady } from '../src/sw/update/commit.js';
import { handleFetch } from '../src/sw/fetch/index.js';
import { getActive, getStaged, openActive } from '../src/sw/cache/store.js';
import { loadCachedSnapshot } from '../src/sw/update/manifest.js';
import { getConfig } from '../src/sw/config/index.js';

const cfg = (extra = {}) => JSON.stringify({ routes: [{ match: '**', strategy: 'network-first' }], precache: ['/app.js'], ...extra });
const v1 = { '/config.json': cfg(), '/app.js': 'app v1' };

// Node's Request refuses mode 'navigate', so present a normal request as one
const asNavigation = (r) => new Proxy(r, {
  get: (t, k) => (k === 'mode' ? 'navigate' : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
});

const navigate = async (path = '/') => {
  let responded;
  handleFetch({ request: asNavigation(req(path)), respondWith: (p) => { responded = p; }, waitUntil() {} });
  return responded;
};

test('install: first install stages and goes live in one pass, then the first check downloads nothing', async () => {
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  setupEnv(server.fetch);

  await precacheFiles();
  assert.equal((await getActive()).version, '1.0.0');
  assert.equal((await loadCachedSnapshot()).version, '1.0.0');
  assert.equal(server.fileCalls().length, 2, 'each file downloaded exactly once');

  server.calls.length = 0;
  const result = await checkForUpdate();
  assert.equal(result.updated, false);
  assert.deepEqual(server.fileCalls(), [], 'no second download on activate');
  assert.deepEqual(messages.map((m) => m.type), ['NO_UPDATE']);
});

test('install: precache fallback when there is no update manifest (and no stale HTTP cache)', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  const seen = [];
  let manifestUp = false; // `nlpwa update` hasn't been deployed yet at install time
  setupEnv(async (r) => {
    seen.push(r.cache);
    if (!manifestUp && new URL(r.url).pathname.startsWith('/api/')) return new Response('', { status: 404 });
    return server.fetch(r);
  }, { precache: ['/app.js'] });

  await precacheFiles();
  const cache = await caches.open('offline');
  assert.ok(await cache.match(req('/app.js')));
  assert.ok(await cache.match(req('/config.json')));
  assert.ok(seen.includes('reload') || seen.includes('no-store'));

  // once the manifest exists, the next check builds the hashed snapshot and switches over
  manifestUp = true;
  const result = await checkForUpdate();
  assert.equal(result.initial, true);
  assert.equal((await loadCachedSnapshot()).version, '1.0.0');

  const currentKeys = await caches.keys();
  assert.ok(!currentKeys.includes('offline'), 'plain offline cache was cleanly migrated and removed');
});


test('update: new version is staged and announced, but the app keeps serving the old one', async () => {
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  messages.length = 0;

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  const result = await checkForUpdate();
  assert.equal(result.updated, true);
  assert.equal(result.staged, true);
  assert.equal(messages.at(-1).type, 'UPDATE_READY');
  assert.equal(messages.at(-1).version, '1.0.1');

  const active = await getActive();
  assert.equal(active.version, '1.0.0');
  assert.equal(await (await (await caches.open(active.cache)).match(req('/app.js'))).text(), 'app v1');
  assert.equal((await getStaged()).complete, true);

  // checking again doesn't re-download, it just re-announces the staged update
  server.calls.length = 0;
  await checkForUpdate();
  assert.deepEqual(server.fileCalls(), []);
  assert.equal(messages.at(-1).type, 'UPDATE_READY');
});

test('update: a navigation request switches to the staged version before it is served', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  await checkForUpdate();

  // Precached files are served from the active cache (v1) preventing mixed old/new files while online.
  const sub = await (async () => {
    let p; handleFetch({ request: req('/app.js'), respondWith: (x) => { p = x; }, waitUntil() {} }); return p;
  })();
  assert.equal(await (await sub).text(), 'app v1', 'precached files are served from active cache, not bypassed to network');
  assert.equal((await getActive()).version, '1.0.0');

  await (await navigate('/'));
  assert.equal((await getActive()).version, '1.0.1');
  assert.equal(await getStaged(), null);

  // After navigation commits the staged update, /app.js serves v2 from the new active cache
  const subAfter = await (async () => {
    let p; handleFetch({ request: req('/app.js'), respondWith: (x) => { p = x; }, waitUntil() {} }); return p;
  })();
  assert.equal(await (await subAfter).text(), 'app v2', 'switched to staged v2 upon navigation commit');
});

test('update: a navigation never waits for or collides with a running update', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();
  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  await checkForUpdate();

  // simulate a check in flight: lock is held, so commit must skip instead of blocking
  const { tryAcquire, release } = await import('../src/sw/cache/store.js');
  assert.equal(tryAcquire(), true);
  assert.equal(await commitIfReady(), false);
  release();
  assert.equal(await commitIfReady(), true);
});

test('update: a failed download keeps the old version live and resumes on the next check', async () => {
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();
  messages.length = 0;

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  server.broken.add('/app.js');
  const failed = await checkForUpdate();
  assert.equal(failed.updated, false);
  assert.equal(messages.find((m) => m.type === 'UPDATE_READY'), undefined, 'no banner for an update that is not ready');
  assert.equal(messages.at(-1)?.type, 'UPDATE_FAILED');
  assert.deepEqual(messages.at(-1)?.failed, ['/app.js']);
  assert.equal(await commitIfReady(), false);
  assert.equal((await getActive()).version, '1.0.0');

  server.broken.clear();
  assert.equal((await checkForUpdate()).updated, true);
  assert.equal(await commitIfReady(), true);
  assert.equal((await getActive()).version, '1.0.1');
});

test('update: an engine (SW) version change refetches everything and wipes the runtime cache', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  await (await caches.open('runtime')).put(req('/lazy'), new Response('x'));

  // new SW code ships: engine version bumped, app version unchanged
  setupEnv(server.fetch, { version: '2' });
  globalThis.caches = caches; // same storage, new SW instance
  server.calls.length = 0;
  const result = await checkForUpdate();
  assert.equal(result.updated, true);
  assert.equal(server.fileCalls().length, 2, 'all files refetched');
  await commitIfReady();
  assert.equal((await getActive()).swVersion, '2');
  assert.equal(await (await caches.open('runtime')).match(req('/lazy')), undefined);
  assert.equal(getConfig().version, '2');
});

test('config.json travels with the app shell: routes change only when the update is committed', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();
  assert.equal(getConfig().routes[0].strategy, 'network-first');

  const next = cfg({ routes: [{ match: '**', strategy: 'cache-first' }] });
  server.set('1.0.1', { ...v1, '/config.json': next });
  await checkForUpdate();
  assert.equal(getConfig().routes[0].strategy, 'network-first', 'old routes until commit');
  await commitIfReady();
  assert.equal(getConfig().routes[0].strategy, 'cache-first');
});

test('update: retry backoff activates after MAX_RETRY_ATTEMPTS, periodic skips, manual forces', async () => {
  const server = makeServer('1.0.0', v1);
  fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  server.broken.add('/app.js');

  // Trigger 5 failed attempts to reach MAX_RETRY_ATTEMPTS
  for (let i = 0; i < 5; i++) {
    await checkForUpdate({ force: true });
  }

  const staged = await getStaged();
  assert.equal(staged.retryCount >= 5, true);
  assert.equal(typeof staged.nextRetryAt, 'number');
  assert.equal(staged.nextRetryAt > Date.now(), true);

  // Unforced periodic check will skip due to backoff
  const periodic = await checkForUpdate();
  assert.equal(periodic.updated, false);
  assert.equal(periodic.backingOff, true);

  // Force check proceeds anyway
  server.broken.clear();
  const forced = await checkForUpdate({ force: true });
  assert.equal(forced.updated, true);
});

test('update: clearRuntimeOnUpdate clears runtime cache upon commit', async () => {
  const server = makeServer('1.0.0', {
    ...v1,
    '/config.json': cfg({ clearRuntimeOnUpdate: true }),
  });
  fakeSelf();
  const caches = setupEnv(server.fetch);
  await precacheFiles();

  // Populate runtime cache with a dynamic asset
  const runtime = await caches.open('runtime');
  await runtime.put('https://example.com/assets/logo.png', new Response('old-logo'));
  assert.ok(await runtime.match('https://example.com/assets/logo.png'));

  // Stage update to 1.0.1
  server.set('1.0.1', {
    ...v1,
    '/app.js': 'app v2',
    '/config.json': cfg({ clearRuntimeOnUpdate: true }),
  });
  await checkForUpdate();
  await commitIfReady();

  // Runtime cache should now be cleared
  const runtimeAfter = await caches.open('runtime');
  const matched = await runtimeAfter.match('https://example.com/assets/logo.png');
  assert.equal(matched, undefined, 'runtime cache asset was wiped on commit');
});

test('update: strict verification failure broadcasts UPDATE_FAILED with hash mismatch details', async () => {
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();
  messages.length = 0;

  // Next version has a hash mismatch on /app.js
  const { hash8 } = await import('./helpers/fake-server.js');
  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  server.lie.set('/app.js', hash8('tampered or minified body'));

  const result = await checkForUpdate();
  assert.equal(result.updated, false);
  const failedMsg = messages.find((m) => m.type === 'UPDATE_FAILED');
  assert.ok(failedMsg, 'UPDATE_FAILED broadcasted');
  assert.equal(failedMsg.hasHashMismatch, true);
  assert.deepEqual(failedMsg.failed, ['/app.js']);
  assert.ok(failedMsg.error.includes('Hash mismatch'));
  assert.ok(failedMsg.failedDetails['/app.js'].includes('hash mismatch'));
});

test('update: consecutive retries failing on same file detects persistent failure', async () => {
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  await precacheFiles();

  const { hash8 } = await import('./helpers/fake-server.js');
  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  server.lie.set('/app.js', hash8('tampered body'));

  // Attempt 1
  messages.length = 0;
  await checkForUpdate();
  assert.equal(messages.at(-1)?.persistent, false);

  // Attempt 2 (force check)
  messages.length = 0;
  await checkForUpdate({ force: true });
  assert.equal(messages.at(-1)?.persistent, true);
  assert.equal(messages.at(-1)?.hasHashMismatch, true);
  assert.equal(messages.at(-1)?.retryCount, 2);
});

test('install: failed precache on first install rethrows and does not commit active cache', async () => {
  const server = makeServer('1.0.0', v1);
  server.broken.add('/app.js');
  fakeSelf();
  setupEnv(server.fetch);

  await assert.rejects(
    () => precacheFiles(),
    /Precache incomplete on first install/
  );

  assert.equal(await getActive(), null, 'no active cache committed on failed install');
});

test('install: precacheWithoutManifest rethrows when a precache resource fails on first install', async () => {
  const server = makeServer('1.0.0', v1);
  server.broken.add('/app.js');
  fakeSelf();
  setupEnv(server.fetch, { precache: ['/app.js'] });

  // Simulate no manifest (404 on API)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (r, init) => {
    const url = typeof r === 'string' ? r : r.url;
    if (new URL(url).pathname.startsWith('/api/')) return new Response('', { status: 404 });
    return origFetch(r, init);
  };

  await assert.rejects(
    () => precacheFiles(),
    /Precache failed on first install/
  );

  assert.equal(await getActive(), null);
});

test('install event: failed precache rejects event.waitUntil and skips calling skipWaiting', async () => {
  let skipWaitingCalled = false;
  let waitUntilPromise = null;
  const handlers = {};

  const server = makeServer('1.0.0', v1);
  server.broken.add('/app.js');
  setupEnv(server.fetch);

  globalThis.self.addEventListener = (event, fn) => { handlers[event] = fn; };
  globalThis.self.skipWaiting = async () => { skipWaitingCalled = true; };

  const { initSW } = await import('../src/sw/index.js');
  initSW();

  assert.ok(handlers.install, 'install handler registered');

  handlers.install({
    waitUntil: (p) => { waitUntilPromise = p; },
  });

  await assert.rejects(
    () => waitUntilPromise,
    /Precache incomplete on first install/
  );

  assert.equal(skipWaitingCalled, false, 'skipWaiting was NOT called after install failure');
});

test('router: built-in non-overridable rule serves precached/manifest files from active cache even if route says network-first or network-only', async () => {
  const routes = [
    { match: '/app.js', strategy: 'network-only' },
    { match: '**', strategy: 'network-first' },
  ];
  const customConfig = { routes, precache: ['/app.js', '/index.html'] };
  const v = { '/config.json': JSON.stringify(customConfig), '/app.js': 'offline app v1' };
  const server = makeServer('1.0.0', v);
  fakeSelf();
  setupEnv(server.fetch, customConfig);
  await precacheFiles();

  // Server updates to v2 online
  server.set('1.0.0', { ...v, '/app.js': 'server app v2' });

  // Precached file /app.js must be served from active cache (offline app v1)
  const res = await (async () => {
    let p; handleFetch({ request: req('/app.js'), respondWith: (x) => { p = x; }, waitUntil() {} }); return p;
  })();
  assert.equal(await (await res).text(), 'offline app v1');
  assert.equal((await res).headers.get('X-Cache-Status'), 'offline-cache');
});

test('update: rollback to active version while an update is staged discards the staged update', async () => {
  const v1 = { '/config.json': cfg(), '/app.js': 'app v1' };
  const v2 = { '/config.json': cfg(), '/app.js': 'app v2' };
  const server = makeServer('1.0.0', v1);
  const messages = fakeSelf();
  setupEnv(server.fetch);

  // 1. Initial install at v1.0.0
  await precacheFiles();
  assert.equal((await getActive()).version, '1.0.0');

  // 2. Deploy v2 to server, check for update to stage it
  server.set('1.0.1', v2);
  const updateResult = await checkForUpdate();
  assert.equal(updateResult.updated, true);
  assert.equal(updateResult.version, '1.0.1');

  const staged = await getStaged();
  assert.ok(staged, 'Update must be staged');
  assert.equal(staged.version, '1.0.1');
  assert.equal(staged.complete, true);
  const stagedCacheName = staged.cache;
  assert.ok((await caches.keys()).includes(stagedCacheName), 'Staged cache must exist in storage');

  // 3. Server rolls back to v1.0.0 before user navigates
  server.set('1.0.0', v1);
  messages.length = 0;

  const rollbackCheck = await checkForUpdate();
  assert.equal(rollbackCheck.updated, false);
  assert.equal(rollbackCheck.rolledBack, true);
  assert.ok(messages.some((m) => m.type === 'NO_UPDATE'));

  // Staged update must be discarded and its cache deleted
  assert.equal(await getStaged(), null, 'Staged record must be cleared upon rollback');
  assert.equal((await caches.keys()).includes(stagedCacheName), false, 'Staged cache must be deleted from storage');

  // 4. Next navigation must NOT apply the discarded v2; it stays on v1.0.0
  await navigate('/');
  assert.equal((await getActive()).version, '1.0.0');
});

