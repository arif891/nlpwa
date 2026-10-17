import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent, sleep } from './helpers/fake-env.js';
import { networkFirst, staleWhileRevalidate } from '../src/sw/fetch/strategies.js';

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
