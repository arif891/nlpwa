import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent, sleep } from './helpers/fake-env.js';
import {
  networkFirst,
  staleWhileRevalidate,
  cacheFirst,
  networkOnly,
  parseDurationMs,
} from '../src/sw/fetch/strategies/index.js';
import { tagResponse } from '../src/sw/cache/tag.js';

const text = (r) => r.text();

test('networkFirst timeout: serves cache when one exists and refreshes it later', async () => {
  const caches = setupEnv(async () => { await sleep(60); return new Response('fresh'); });
  await (await caches.open('runtime')).put(req('/page'), new Response('cached'));

  const event = fakeEvent();
  const res = await networkFirst(req('/page'), event, { networkTimeoutMs: 10 });
  assert.equal(await text(res), 'cached');
  assert.equal(res.headers.get('X-Cache-Status'), 'runtime-cache');

  await event.settle();
  const updated = await (await caches.open('runtime')).match(req('/page'));
  assert.equal(await text(updated), 'fresh');
});

test('networkFirst timeout: with nothing cached it waits for the slow network, not a 503', async () => {
  setupEnv(async () => { await sleep(60); return new Response('slow but fine'); });
  const res = await networkFirst(req('/page'), fakeEvent(), { networkTimeoutMs: 10 });
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'slow but fine');
  assert.equal(res.headers.get('X-Cache-Status'), 'network');
});

test('networkFirst: network failure with empty cache gives the offline 503', async () => {
  setupEnv(async () => { throw new TypeError('offline'); });
  const res = await networkFirst(req('/page'), fakeEvent(), { networkTimeoutMs: 10 });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-fallback');
});

test('networkFirst: fallbackOn5xx: true serves cached copy when server returns 500', async () => {
  const caches = setupEnv(async () => new Response('Internal Server Error', { status: 500 }));
  await (await caches.open('runtime')).put(req('/page'), new Response('cached resilient'));

  const event = fakeEvent();
  const res = await networkFirst(req('/page'), event, { fallbackOn5xx: true });
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'cached resilient');
  assert.equal(res.headers.get('X-Cache-Status'), 'runtime-cache');
});

test('networkFirst: default behavior returns 500 response as-is without falling back', async () => {
  const caches = setupEnv(async () => new Response('Internal Server Error', { status: 500 }));
  await (await caches.open('runtime')).put(req('/page'), new Response('cached copy'));

  const event = fakeEvent();
  const res = await networkFirst(req('/page'), event, { fallbackOn5xx: false });
  assert.equal(res.status, 500);
  assert.equal(await text(res), 'Internal Server Error');
});

test('staleWhileRevalidate: cache miss performs exactly one network request', async () => {
  let calls = 0;
  const caches = setupEnv(async () => { calls++; return new Response('body'); });
  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event);
  assert.equal(await text(res), 'body');
  await event.settle();
  assert.equal(calls, 1);
  // and the response was stored for next time
  assert.ok(await (await caches.open('runtime')).match(req('/feed')));
});

test('staleWhileRevalidate: cache hit serves stale, then refreshes in the background', async () => {
  let calls = 0;
  const caches = setupEnv(async () => { calls++; return new Response('new'); });
  await (await caches.open('runtime')).put(req('/feed'), new Response('old'));
  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event);
  assert.equal(await text(res), 'old');
  assert.equal(res.headers.get('X-Cache-Status'), 'stale');
  await event.settle();
  assert.equal(calls, 1);
  assert.equal(await text(await (await caches.open('runtime')).match(req('/feed'))), 'new');
});

test('staleWhileRevalidate: offline with a cached copy does not throw', async () => {
  const caches = setupEnv(async () => { throw new TypeError('offline'); });
  await (await caches.open('runtime')).put(req('/feed'), new Response('old'));
  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event);
  assert.equal(await text(res), 'old');
  await event.settle(); // must resolve, not reject
});

test('staleWhileRevalidate: offline cache miss returns 503 offline-fallback without throwing', async () => {
  setupEnv(async () => { throw new TypeError('offline'); });
  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-fallback');
});

test('staleWhileRevalidate: offline cache miss for navigation returns navigationFallback', async () => {
  const caches = setupEnv(async () => { throw new TypeError('offline'); });
  await (await caches.open('offline')).put(req('/index.html'), new Response('spa shell'));
  const navReq = req('/about');
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });
  const event = fakeEvent();
  const res = await staleWhileRevalidate(navReq, event, { navigationFallback: '/index.html' });
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'spa shell');
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-cache');
});

test('cacheFirst: serves from offline cache when present', async () => {
  const caches = setupEnv(async () => new Response('network'));
  await (await caches.open('offline')).put(req('/assets/logo.png'), new Response('offline-logo'));
  const res = await cacheFirst(req('/assets/logo.png'), fakeEvent());
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'offline-logo');
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-cache');
});

test('cacheFirst: serves from runtime cache when offline cache misses', async () => {
  const caches = setupEnv(async () => new Response('network'));
  await (await caches.open('runtime')).put(req('/assets/avatar.png'), new Response('runtime-avatar'));
  const res = await cacheFirst(req('/assets/avatar.png'), fakeEvent());
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'runtime-avatar');
  assert.equal(res.headers.get('X-Cache-Status'), 'runtime-cache');
});

test('cacheFirst: on cache miss fetches from network and stores in runtime cache', async () => {
  const caches = setupEnv(async () => new Response('network-file'));
  const event = fakeEvent();
  const res = await cacheFirst(req('/assets/new.png'), event);
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'network-file');
  assert.equal(res.headers.get('X-Cache-Status'), 'network');
  await event.settle();
  const cached = await (await caches.open('runtime')).match(req('/assets/new.png'));
  assert.ok(cached);
  assert.equal(await text(cached), 'network-file');
});

test('cacheFirst: network failure returns offline 503 fallback without throwing', async () => {
  setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  const event = fakeEvent();
  const res = await cacheFirst(req('/assets/missing.png'), event);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-fallback');
});

test('cacheFirst: offline navigation request falls back to navigationFallback', async () => {
  const caches = setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  await (await caches.open('offline')).put(req('/index.html'), new Response('offline-fallback-app'));
  const navReq = req('/assets/page');
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });
  const event = fakeEvent();
  const res = await cacheFirst(navReq, event, { navigationFallback: '/index.html' });
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'offline-fallback-app');
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-cache');
});

test('networkOnly: returns network response tagged with network', async () => {
  setupEnv(async () => new Response('data'));
  const res = await networkOnly(req('/api/users'));
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'data');
  assert.equal(res.headers.get('X-Cache-Status'), 'network');
});

test('networkOnly: network failure returns 503 without throwing unhandled error', async () => {
  setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  const res = await networkOnly(req('/api/users'));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Cache-Status'), 'offline-fallback');
});

test('networkOnly: throwOnFailure rethrows network rejection for offline API handling', async () => {
  setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(
    async () => networkOnly(req('/api/users'), undefined, { throwOnFailure: true }),
    { name: 'TypeError', message: 'Failed to fetch' }
  );
});

test('networkFirst & cacheFirst: throwOnFailure rethrows when resource is not cached', async () => {
  setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(
    async () => networkFirst(req('/api/users'), undefined, { throwOnFailure: true }),
    { name: 'TypeError' }
  );
  await assert.rejects(
    async () => cacheFirst(req('/api/users'), undefined, { throwOnFailure: true }),
    { name: 'TypeError' }
  );
});

test('tagResponse: preserves response.url and response.redirected', () => {
  const original = new Response('content', { status: 200 });
  Object.defineProperty(original, 'url', { value: 'https://example.com/api/v1/resource' });
  Object.defineProperty(original, 'redirected', { value: true });

  const tagged = tagResponse(original, 'network');
  assert.equal(tagged.headers.get('X-Cache-Status'), 'network');
  assert.equal(tagged.url, 'https://example.com/api/v1/resource');
  assert.equal(tagged.redirected, true);
});

test('parseDurationMs: parses friendly string durations and numbers', () => {
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs('30s'), 30000);
  assert.equal(parseDurationMs('15m'), 900000);
  assert.equal(parseDurationMs('2h'), 7200000);
  assert.equal(parseDurationMs('7d'), 604800000);
  assert.equal(parseDurationMs(5000), 5000);
  assert.equal(parseDurationMs(null), null);
  assert.equal(parseDurationMs('invalid'), null);
});

test('cacheFirst: serves unexpired runtime cache when within maxAge', async () => {
  const caches = setupEnv(async () => new Response('fresh'));
  const cachedRes = new Response('cached', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 5000) },
  });
  await (await caches.open('runtime')).put(req('/assets/logo.png'), cachedRes);

  const res = await cacheFirst(req('/assets/logo.png'), undefined, { maxAge: '1m' });
  assert.equal(await res.text(), 'cached');
  assert.equal(res.headers.get('X-Cache-Status'), 'runtime-cache');
});

test('cacheFirst: refreshes from network and updates cache when runtime cache exceeds maxAge', async () => {
  let networkFetches = 0;
  const caches = setupEnv(async () => {
    networkFetches++;
    return new Response('fresh');
  });
  // 2 hours old
  const staleRes = new Response('stale', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 7200000) },
  });
  await (await caches.open('runtime')).put(req('/assets/logo.png'), staleRes);

  const event = fakeEvent();
  const res = await cacheFirst(req('/assets/logo.png'), event, { maxAge: '1h' });
  assert.equal(await res.text(), 'fresh');
  assert.equal(res.headers.get('X-Cache-Status'), 'network');
  assert.equal(networkFetches, 1);

  await event.settle();
  // Check updated cache
  const updated = await (await caches.open('runtime')).match(req('/assets/logo.png'));
  assert.equal(await updated.text(), 'fresh');
});

test('cacheFirst: expired maxAge falls back gracefully to stale cache when offline', async () => {
  const caches = setupEnv(async () => { throw new TypeError('Failed to fetch'); });
  const staleRes = new Response('stale-offline', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 7200000) },
  });
  await (await caches.open('runtime')).put(req('/assets/logo.png'), staleRes);

  const res = await cacheFirst(req('/assets/logo.png'), undefined, { maxAge: '1h' });
  assert.equal(await res.text(), 'stale-offline');
  assert.equal(res.headers.get('X-Cache-Status'), 'runtime-cache');
});

test('staleWhileRevalidate: serves stale immediately when within maxAge', async () => {
  let networkFetches = 0;
  const caches = setupEnv(async () => {
    networkFetches++;
    return new Response('fresh');
  });
  const cachedRes = new Response('cached', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 5000) },
  });
  await (await caches.open('runtime')).put(req('/feed'), cachedRes);

  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event, { maxAge: '1h' });
  assert.equal(await res.text(), 'cached');
  assert.equal(res.headers.get('X-Cache-Status'), 'stale');

  await event.settle();
  assert.equal(networkFetches, 1);
});

test('staleWhileRevalidate: blocks on network when runtime cache exceeds maxAge', async () => {
  let networkFetches = 0;
  const caches = setupEnv(async () => {
    networkFetches++;
    return new Response('fresh-from-network');
  });
  const expiredRes = new Response('expired-cached', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 7200000) },
  });
  await (await caches.open('runtime')).put(req('/feed'), expiredRes);

  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event, { maxAge: '1h' });
  assert.equal(await res.text(), 'fresh-from-network');
  assert.equal(res.headers.get('X-Cache-Status'), 'network');
  assert.equal(networkFetches, 1);
});

test('staleWhileRevalidate: expired maxAge falls back to stale cache when offline', async () => {
  const caches = setupEnv(async () => { throw new TypeError('Network down'); });
  const expiredRes = new Response('expired-cached-fallback', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now() - 7200000) },
  });
  await (await caches.open('runtime')).put(req('/feed'), expiredRes);

  const event = fakeEvent();
  const res = await staleWhileRevalidate(req('/feed'), event, { maxAge: '1h' });
  assert.equal(await res.text(), 'expired-cached-fallback');
  assert.equal(res.headers.get('X-Cache-Status'), 'stale');
});


