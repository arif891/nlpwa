import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { putInRuntime } from '../src/sw/cache/runtime.js';
import { getStorageQuotaInfo, cleanRuntimeCache } from '../src/sw/cache/cleanup.js';
import { CLEANUP_STRATEGIES, MESSAGE_TYPES } from '../src/shared/constants.js';

function mockStorage(estimateFn) {
  if (!globalThis.navigator) {
    globalThis.navigator = {};
  }
  try {
    Object.defineProperty(globalThis.navigator, 'storage', {
      value: { estimate: estimateFn },
      configurable: true,
      writable: true,
    });
  } catch {
    globalThis.navigator.storage = { estimate: estimateFn };
  }
}

test('getStorageQuotaInfo: reports quota and runtime cache metrics', async () => {
  setupEnv(() => new Response('ok'));

  mockStorage(async () => ({
    quota: 100 * 1024 * 1024, // 100 MB
    usage: 10 * 1024 * 1024,  // 10 MB
  }));

  // Put a few entries into runtime
  const small = new Response('small', { headers: { 'Content-Length': '5' } });
  const medium = new Response('medium body text', { headers: { 'Content-Length': '16' } });
  const large = new Response('x'.repeat(1024), { headers: { 'Content-Length': '1024' } });

  await putInRuntime(req('/assets/small.txt'), small);
  await putInRuntime(req('/assets/medium.txt'), medium);
  await putInRuntime(req('/assets/large.bin'), large);

  const info = await getStorageQuotaInfo();

  assert.equal(info.quota, 100 * 1024 * 1024);
  assert.equal(info.usage, 10 * 1024 * 1024);
  assert.equal(info.percentUsed, 10);
  assert.equal(info.runtimeEntries, 3);
  assert.equal(info.runtimeBytes, 5 + 16 + 1024);
  assert.equal(info.largestEntries.length, 3);
  // Largest entry must be first
  assert.equal(info.largestEntries[0].url, 'https://example.com/assets/large.bin');
  assert.equal(info.largestEntries[0].size, 1024);
});

test('cleanup: strategy "largest" evicts biggest files first to fit maxTotalBytes', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/assets/100b.dat'), new Response('a', { headers: { 'Content-Length': '100' } }));
  await putInRuntime(req('/assets/500b.dat'), new Response('b', { headers: { 'Content-Length': '500' } }));
  await putInRuntime(req('/assets/1000b.dat'), new Response('c', { headers: { 'Content-Length': '1000' } }));

  // Total is 1600 bytes. Limit to maxTotalBytes = 550 bytes.
  // The 1000b item should be evicted first (remaining 600b), then 500b item (remaining 100b <= 550b).
  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.LARGEST,
    maxTotalBytes: 550,
  });

  assert.equal(result.success, true);
  assert.equal(result.evictedCount, 2);
  assert.ok(result.evictedUrls.includes('https://example.com/assets/1000b.dat'));
  assert.ok(result.evictedUrls.includes('https://example.com/assets/500b.dat'));
  assert.equal(result.remainingEntries, 1);
  assert.equal(result.remainingBytes, 100);

  // Verify only the 100b file remains in cache
  const cache = await caches.open('runtime');
  const remaining = await cache.keys();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].url, 'https://example.com/assets/100b.dat');
});

test('cleanup: filter maxItemBytes evicts any individual oversized file', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/assets/tiny.png'), new Response('a', { headers: { 'Content-Length': '20' } }));
  await putInRuntime(req('/assets/huge.mp4'), new Response('b', { headers: { 'Content-Length': '5000' } }));

  const result = await cleanRuntimeCache({
    maxItemBytes: 1000, // anything over 1KB is evicted
  });

  assert.equal(result.evictedCount, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/assets/huge.mp4'));
  assert.equal(result.remainingEntries, 1);
});

test('cleanup: filter minItemBytes evicts items larger than or equal to threshold', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/assets/a.dat'), new Response('a', { headers: { 'Content-Length': '100' } }));
  await putInRuntime(req('/assets/b.dat'), new Response('b', { headers: { 'Content-Length': '2000' } }));

  const result = await cleanRuntimeCache({
    minItemBytes: 1000,
  });

  assert.equal(result.evictedCount, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/assets/b.dat'));
});

test('cleanup: strategy "lru" evicts oldest entries first', async () => {
  setupEnv(() => new Response('ok'));

  const now = Date.now();
  const oldRes = new Response('old', {
    headers: { 'Content-Length': '10', 'X-NLPWA-Cached-At': String(now - 100000) },
  });
  const newRes = new Response('new', {
    headers: { 'Content-Length': '10', 'X-NLPWA-Cached-At': String(now) },
  });

  await putInRuntime(req('/old.js'), oldRes);
  await putInRuntime(req('/new.js'), newRes);

  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.LRU,
    maxEntries: 1,
  });

  assert.equal(result.evictedCount, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/old.js'));
  assert.equal(result.remainingEntries, 1);
});

test('cleanup: strategy "max-age" evicts expired entries', async () => {
  setupEnv(() => new Response('ok'));

  const now = Date.now();
  const expiredRes = new Response('expired', {
    headers: { 'Content-Length': '10', 'X-NLPWA-Cached-At': String(now - 86400000) }, // 24h old
  });
  const freshRes = new Response('fresh', {
    headers: { 'Content-Length': '10', 'X-NLPWA-Cached-At': String(now) },
  });

  await putInRuntime(req('/expired.js'), expiredRes);
  await putInRuntime(req('/fresh.js'), freshRes);

  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.MAX_AGE,
    maxAgeMs: 3600000, // 1 hour max age
  });

  assert.equal(result.evictedCount, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/expired.js'));
  assert.equal(result.remainingEntries, 1);
});

test('cleanup: strategy "quota" evicts largest items when over percentage threshold', async () => {
  setupEnv(() => new Response('ok'));

  mockStorage(async () => ({
    quota: 10000,
    usage: 9000, // 90% used
  }));

  await putInRuntime(req('/assets/small.jpg'), new Response('s', { headers: { 'Content-Length': '200' } }));
  await putInRuntime(req('/assets/large.jpg'), new Response('l', { headers: { 'Content-Length': '3000' } }));

  // Target max 70% of 10000 = 7000. Usage is 9000. Evicting 3000 leaves 6000 <= 7000.
  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.QUOTA,
    maxQuotaPercent: 70,
  });

  assert.equal(result.evictedCount, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/assets/large.jpg'));
  assert.equal(result.remainingEntries, 1);
});

test('cleanup: strategy "pattern" evicts matching glob URLs', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/api/temp/1'), new Response('1', { headers: { 'Content-Length': '10' } }));
  await putInRuntime(req('/api/temp/2'), new Response('2', { headers: { 'Content-Length': '10' } }));
  await putInRuntime(req('/assets/main.css'), new Response('css', { headers: { 'Content-Length': '50' } }));

  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.PATTERN,
    match: '/api/temp/**',
  });

  assert.equal(result.evictedCount, 2);
  assert.equal(result.remainingEntries, 1);
  assert.ok(result.evictedUrls.includes('https://example.com/api/temp/1'));
  assert.ok(result.evictedUrls.includes('https://example.com/api/temp/2'));
});

test('cleanup: strategy "all" purges all runtime entries', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/a.js'), new Response('a', { headers: { 'Content-Length': '10' } }));
  await putInRuntime(req('/b.js'), new Response('b', { headers: { 'Content-Length': '20' } }));

  const result = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.ALL,
  });

  assert.equal(result.evictedCount, 2);
  assert.equal(result.remainingEntries, 0);
  assert.equal(result.remainingBytes, 0);
});

test('message communication: GET_CACHE_INFO and CLEANUP_RUNTIME via MessageChannel', async () => {
  setupEnv(() => new Response('ok'));

  const messageListeners = [];
  globalThis.self = {
    addEventListener: (event, handler) => {
      if (event === 'message') messageListeners.push(handler);
    },
    clients: { claim: async () => {} },
  };

  const { initSW } = await import('../src/sw/index.js');
  initSW({ version: '1' });

  await putInRuntime(req('/assets/large.dat'), new Response('x'.repeat(500), { headers: { 'Content-Length': '500' } }));
  await putInRuntime(req('/assets/small.dat'), new Response('y'.repeat(50), { headers: { 'Content-Length': '50' } }));

  const handler = messageListeners[0];
  assert.ok(handler, 'Message handler was registered');

  // Test GET_CACHE_INFO
  let infoReply = null;
  const infoPort = {
    postMessage: (msg) => { infoReply = msg; },
  };
  let pendingInfo = [];
  handler({
    data: { type: MESSAGE_TYPES.GET_CACHE_INFO, requestId: 'test-1' },
    ports: [infoPort],
    waitUntil: (p) => pendingInfo.push(p),
  });
  await Promise.all(pendingInfo);

  assert.ok(infoReply, 'Replied to GET_CACHE_INFO');
  assert.equal(infoReply.type, MESSAGE_TYPES.CACHE_INFO);
  assert.equal(infoReply.requestId, 'test-1');
  assert.equal(infoReply.data.runtimeEntries, 2);

  // Test CLEANUP_RUNTIME with strategy: 'largest'
  let cleanupReply = null;
  const cleanupPort = {
    postMessage: (msg) => { cleanupReply = msg; },
  };
  let pendingCleanup = [];
  handler({
    data: {
      type: MESSAGE_TYPES.CLEANUP_RUNTIME,
      requestId: 'test-2',
      options: { strategy: CLEANUP_STRATEGIES.LARGEST, maxEntries: 1 },
    },
    ports: [cleanupPort],
    waitUntil: (p) => pendingCleanup.push(p),
  });
  await Promise.all(pendingCleanup);

  assert.ok(cleanupReply, 'Replied to CLEANUP_RUNTIME');
  assert.equal(cleanupReply.type, MESSAGE_TYPES.RUNTIME_CLEANED);
  assert.equal(cleanupReply.requestId, 'test-2');
  assert.equal(cleanupReply.data.evictedCount, 1);
  assert.equal(cleanupReply.data.remainingEntries, 1);
  assert.ok(cleanupReply.data.evictedUrls.includes('https://example.com/assets/large.dat'));
});

test('cleanup: supports KB, MB, and string units (e.g. maxTotalMB, maxItemKB, "500KB")', async () => {
  setupEnv(() => new Response('ok'));

  // Put a 2 MB file and a 500 KB file into runtime cache
  const twoMb = 2 * 1024 * 1024;
  const fiveHundredKb = 500 * 1024;

  await putInRuntime(req('/2mb.bin'), new Response('x', { headers: { 'Content-Length': String(twoMb) } }));
  await putInRuntime(req('/500kb.bin'), new Response('y', { headers: { 'Content-Length': String(fiveHundredKb) } }));

  // 1. Evict any file > 1 MB using maxItemMB: 1
  const result1 = await cleanRuntimeCache({
    maxItemMB: 1,
  });
  assert.equal(result1.evictedCount, 1);
  assert.ok(result1.evictedUrls.includes('https://example.com/2mb.bin'));
  assert.equal(result1.remainingEntries, 1);

  // 2. Put a 600 KB file and evict using string '550KB'
  const sixHundredKb = 600 * 1024;
  await putInRuntime(req('/600kb.bin'), new Response('z', { headers: { 'Content-Length': String(sixHundredKb) } }));

  // Now we have 500kb + 600kb = 1100kb. Limit total to 700KB via maxTotalKB: 700
  const result2 = await cleanRuntimeCache({
    strategy: CLEANUP_STRATEGIES.LARGEST,
    maxTotalKB: 700,
  });
  // Largest (600 KB) is evicted, leaving 500 KB <= 700 KB
  assert.equal(result2.evictedCount, 1);
  assert.ok(result2.evictedUrls.includes('https://example.com/600kb.bin'));
  assert.equal(result2.remainingEntries, 1);

  // 3. String units e.g. maxItem: '400KB'
  const result3 = await cleanRuntimeCache({
    maxItem: '400KB',
  });
  // 500 KB file > 400 KB -> evicted
  assert.equal(result3.evictedCount, 1);
  assert.ok(result3.evictedUrls.includes('https://example.com/500kb.bin'));
  assert.equal(result3.remainingEntries, 0);
});

test('cleanup: serializes concurrent cleanRuntimeCache calls without colliding', async () => {
  setupEnv(() => new Response('ok'));

  await putInRuntime(req('/file1.dat'), new Response('1', { headers: { 'Content-Length': '100' } }));
  await putInRuntime(req('/file2.dat'), new Response('2', { headers: { 'Content-Length': '200' } }));
  await putInRuntime(req('/file3.dat'), new Response('3', { headers: { 'Content-Length': '300' } }));

  // Run two concurrent cleanups simultaneously
  const [res1, res2] = await Promise.all([
    cleanRuntimeCache({ maxItemBytes: 150 }),
    cleanRuntimeCache({ strategy: CLEANUP_STRATEGIES.ALL }),
  ]);

  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  // Both executed cleanly without errors and cache is empty
  const cache = await caches.open('runtime');
  const remaining = await cache.keys();
  assert.equal(remaining.length, 0);
});

