import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { getActive, resetActiveMemo } from '../src/sw/cache/meta/index.js';
import { cacheFirst } from '../src/sw/fetch/strategies/cache-first.js';
import { checkForUpdate } from '../src/sw/update/index.js';

const cfg = () => JSON.stringify({
  version: '1',
  caches: { offline: 'offline', runtime: 'runtime' },
  routes: [{ match: '**', strategy: 'network-first' }],
  precache: ['/config.json', '/app.js'],
});

test('safari ITP cache eviction: mid-session cache deletion falls back to network and auto-recovers on update check', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'console.log("active app");',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const activeBefore = await getActive();
  assert.ok(activeBefore);
  const cacheName = activeBefore.cache;
  assert.ok(cacheName);

  // Serve from cache first works
  const resBefore = await cacheFirst(new Request('https://example.com/app.js'));
  assert.equal(resBefore.headers.get('x-cache-status'), 'offline-cache');

  // Simulate Safari ITP or low-disk storage pressure evicting the offline cache
  await caches.delete(cacheName);
  resetActiveMemo();

  // getActive() detects that the cache was evicted by the browser, cleans stale pointer, and returns null
  const activeAfterEviction = await getActive();
  assert.equal(activeAfterEviction, null, 'Active pointer must be cleared when cache was evicted');

  // Next request does not crash — falls back to network
  const resAfterEviction = await cacheFirst(new Request('https://example.com/app.js'));
  assert.equal(resAfterEviction.status, 200);
  assert.equal(resAfterEviction.headers.get('x-cache-status'), 'network');

  // Trigger update check: notices no active cache (isFresh = true) and rebuilds offline cache from network
  await checkForUpdate({ force: true });

  const activeRecovered = await getActive();
  assert.ok(activeRecovered, 'Offline cache must be re-bootstrapped after eviction');
  assert.equal(activeRecovered.version, '1.0.0');

  // Once bootstrapped, cache-first serving is fully restored
  const resRestored = await cacheFirst(new Request('https://example.com/app.js'));
  assert.equal(resRestored.headers.get('x-cache-status'), 'offline-cache');
});
