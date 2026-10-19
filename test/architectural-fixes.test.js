import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { checkForUpdate, getUpdateStatus } from '../src/sw/update/index.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { commitStaged, commitIfReady } from '../src/sw/update/commit.js';
import { getActive, getStaged, setActive, setStaged, resetStoreMemo, clearActive } from '../src/sw/cache/store.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { register } from '../src/client/register.js';

const cfg = (extra = {}) => JSON.stringify({ routes: [{ match: '**', strategy: 'network-first' }], precache: ['/app.js'], ...extra });
const v1 = { '/config.json': cfg(), '/app.js': 'app v1' };

test('status bug: manifest fetch failure resets status from checking to idle', async () => {
  // Server returns 500 for manifest fetch
  const server = makeServer('1.0.0', v1);
  setupEnv(async (r) => {
    const url = new URL(r.url);
    if (url.pathname.includes('/info.json')) {
      return new Response('Manifest Error', { status: 500 });
    }
    return server.fetch(r);
  });

  await precacheFiles();
  assert.equal(await getUpdateStatus(), 'idle');

  // Trigger update check where manifest fetch fails
  const result = await checkForUpdate();
  assert.equal(result.updated, false);
  assert.equal(await getUpdateStatus(), 'idle', 'status must be reset to idle on manifest fetch failure');
});

test('status bug: staging retry backoff resets status from checking to idle', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  await precacheFiles();

  // Manually set a staged record in backoff
  await setStaged({
    cache: 'offline@1.0.1-temp',
    version: '1.0.1',
    swVersion: '1',
    complete: false,
    retryCount: 5,
    nextRetryAt: Date.now() + 60000,
  });

  const result = await checkForUpdate();
  assert.equal(result.backingOff, true);
  assert.equal(await getUpdateStatus(), 'idle', 'status must be reset to idle when staging is in backoff');
});

test('cleanup: commitStaged moves heavy disk cleanup into event.waitUntil', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await precacheFiles();

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  const manifest = await (await server.fetch(req('/api/update/info.json'))).json();
  const stageRes = await stageUpdate(manifest);
  assert.equal(stageRes.status, 'ready');

  let waitUntilCalled = false;
  let waitUntilPromise = null;
  const fakeEvent = {
    waitUntil(p) {
      waitUntilCalled = true;
      waitUntilPromise = p;
    },
  };

  const committed = await commitStaged(fakeEvent);
  assert.equal(committed, true);
  assert.equal(waitUntilCalled, true, 'cleanupPromise must be passed to event.waitUntil');

  // Active pointer flipped immediately
  assert.equal((await getActive()).version, '1.0.1');

  // Await the deferred cleanup and verify it completes
  await waitUntilPromise;
  assert.equal(await getUpdateStatus(), 'idle');
});

test('crash window: commitStaged guards against re-committing already active cache', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  await precacheFiles();

  const active = await getActive();
  // Simulate crash between setActive and clearStaged:
  // staged record still points to the same cache that was already made active
  await setStaged({
    cache: active.cache,
    version: active.version,
    swVersion: '1',
    complete: true,
  });

  const committed = await commitStaged();
  assert.equal(committed, false, 'should return false and not re-commit or re-broadcast');
  assert.equal(await getStaged(), null, 'stale staged record should be cleared');
});

test('commit: retainPreviousVersionCache is read from the newly loaded config', async () => {
  // Start with default config (retainPreviousVersionCache: true)
  const server = makeServer('1.0.0', {
    '/config.json': cfg({ retainPreviousVersionCache: true }),
    '/app.js': 'app v1',
  });
  const caches = setupEnv(server.fetch);
  await precacheFiles();
  const v1Active = await getActive();

  // v2 config has retainPreviousVersionCache: false
  server.set('2.0.0', {
    '/config.json': cfg({ retainPreviousVersionCache: false }),
    '/app.js': 'app v2',
  });

  const manifest = await (await server.fetch(req('/api/update/info.json'))).json();
  await stageUpdate(manifest);
  await commitStaged();

  const v2Active = await getActive();
  assert.equal(v2Active.version, '2.0.0');
  assert.equal(v2Active.previousCache, undefined, 'previousCache should not be retained when new config disables it');
});

test('browser eviction: getActive() clears stale pointer when cache was deleted by browser', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await precacheFiles();

  const active = await getActive();
  assert.ok(active?.cache);

  // Simulate browser storage eviction deleting the offline cache
  await caches.delete(active.cache);

  // SW restart: memoized promise is null, reads from meta cache
  resetStoreMemo();

  const recovered = await getActive();
  assert.equal(recovered, null, 'getActive() must return null and clear stale active.json when cache is evicted');
});

test('browser eviction: getActive() clears stale pointer when cache is empty', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await precacheFiles();

  const active = await getActive();
  // Simulate an empty cache
  const offlineCache = await caches.open(active.cache);
  const keys = await offlineCache.keys();
  for (const k of keys) {
    await offlineCache.delete(k);
  }

  resetStoreMemo();
  const recovered = await getActive();
  assert.equal(recovered, null, 'getActive() must return null when cache has 0 keys');
});

test('client: register() calls navigator.storage.persist() when persistentStorage is true', async () => {
  let persistCalled = false;
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async () => ({ scope: 'https://example.com/' }),
          controller: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          ready: Promise.resolve(),
        },
        storage: {
          persist: async () => {
            persistCalled = true;
            return true;
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const handle = await register('/sw.js', {
      persistentStorage: true,
      checkOnRegister: false,
      pollIntervalMs: 0,
    });

    assert.equal(persistCalled, true, 'navigator.storage.persist() should be called');
    handle?.unsubscribe?.();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    }
  }
});
