import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent } from './helpers/fake-env.js';
import { setupFakeIDB } from './helpers/fake-idb.js';
import {
  BackgroundSyncPlugin,
  SyncQueue,
  SyncClient,
  serializeRequest,
  deserializeRequest,
} from '../src/plugins/sync/index.js';

test.beforeEach(() => {
  setupFakeIDB();
  setupEnv(() => new Response('ok'));
});

test('sync: serialize and deserialize request preserves method, headers, and body', async () => {
  const original = new Request('https://example.com/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Custom': 'val' },
    body: JSON.stringify({ name: 'Arif', action: 'test' }),
  });

  const serialized = await serializeRequest(original, { queueName: 'test-q' });
  assert.equal(serialized.url, 'https://example.com/api/submit');
  assert.equal(serialized.method, 'POST');
  assert.equal(serialized.queueName, 'test-q');
  assert.ok(serialized.body instanceof ArrayBuffer);

  const restored = deserializeRequest(serialized);
  assert.equal(restored.url, 'https://example.com/api/submit');
  assert.equal(restored.method, 'POST');
  assert.equal(restored.headers.get('content-type'), 'application/json');
  assert.equal(restored.headers.get('x-custom'), 'val');

  const json = await restored.json();
  assert.deepEqual(json, { name: 'Arif', action: 'test' });
});

test('sync queue: push, getAll, size, remove, and clear', async () => {
  const queue = new SyncQueue('forms');
  assert.equal(await queue.size(), 0);

  const req1 = new Request('https://example.com/api/form1', { method: 'POST' });
  const req2 = new Request('https://example.com/api/form2', { method: 'POST' });

  const id1 = await queue.push(req1);
  const id2 = await queue.push(req2);
  assert.ok(id1);
  assert.ok(id2);

  assert.equal(await queue.size(), 2);
  const items = await queue.getAll();
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://example.com/api/form1');
  assert.equal(items[1].url, 'https://example.com/api/form2');

  await queue.remove(id1);
  assert.equal(await queue.size(), 1);

  await queue.clear();
  assert.equal(await queue.size(), 0);
});

test('sync queue: prunes expired items beyond maxRetentionMs', async () => {
  const queue = new SyncQueue('temp-forms', { maxRetentionMs: 1000 });

  const req1 = new Request('https://example.com/api/form1', { method: 'POST' });
  await queue.push(req1, { timestamp: Date.now() - 5000 }); // 5s ago, expired

  const req2 = new Request('https://example.com/api/form2', { method: 'POST' });
  await queue.push(req2, { timestamp: Date.now() }); // fresh

  const items = await queue.getAll();
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/api/form2');
});

test('sync queue: replayAll succeeds on ok response and empties queue', async () => {
  const queue = new SyncQueue('replay-success');
  await queue.push(new Request('https://example.com/api/action1', { method: 'POST' }));
  await queue.push(new Request('https://example.com/api/action2', { method: 'POST' }));

  const calledUrls = [];
  const result = await queue.replayAll({
    fetchImpl: async (r) => {
      calledUrls.push(r.url);
      return new Response('created', { status: 201 });
    },
  });

  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.remainingCount, 0);
  assert.deepEqual(calledUrls, [
    'https://example.com/api/action1',
    'https://example.com/api/action2',
  ]);
});

test('sync queue: replayAll stops loop on network error and updates retryCount', async () => {
  const queue = new SyncQueue('replay-network-fail');
  await queue.push(new Request('https://example.com/api/fail1', { method: 'POST' }));
  await queue.push(new Request('https://example.com/api/fail2', { method: 'POST' }));

  let callCount = 0;
  const result = await queue.replayAll({
    fetchImpl: async () => {
      callCount++;
      throw new Error('Failed to fetch (offline)');
    },
  });

  // Stopped after first network error to avoid flooding
  assert.equal(callCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.remainingCount, 2);

  const items = await queue.getAll();
  assert.equal(items[0].retryCount, 1);
});

test('sync queue: drops request after exceeding maxRetries', async () => {
  const queue = new SyncQueue('max-retries', { maxRetries: 2 });
  await queue.push(new Request('https://example.com/api/fail-perm', { method: 'POST' }));

  // First failure
  await queue.replayAll({ fetchImpl: async () => { throw new Error('Offline'); } });
  assert.equal(await queue.size(), 1);

  // Second failure -> exceeds maxRetries (2) -> discarded
  await queue.replayAll({ fetchImpl: async () => { throw new Error('Offline'); } });
  assert.equal(await queue.size(), 0);
});

test('sync plugin: fetchDidFail captures failed POST and ignores GET', async () => {
  const plugin = new BackgroundSyncPlugin({ queueName: 'plugin-test' });

  // 1. GET request should be ignored
  await plugin.fetchDidFail({
    request: new Request('https://example.com/api/feed', { method: 'GET' }),
    error: new Error('Network error'),
  });
  assert.equal(await plugin.queue.size(), 0);

  // 2. POST request should be enqueued
  await plugin.fetchDidFail({
    request: new Request('https://example.com/api/post', {
      method: 'POST',
      body: 'test payload',
    }),
    error: new Error('Network error'),
  });
  assert.equal(await plugin.queue.size(), 1);

  const items = await plugin.queue.getAll();
  assert.equal(items[0].url, 'https://example.com/api/post');
});

test('sync client: getPending and clear interact with local queue fallback', async () => {
  const queue = new SyncQueue('client-test');
  await queue.push(new Request('https://example.com/api/order', { method: 'POST' }));

  const client = new SyncClient('client-test');
  const pending = await client.getPending('client-test');
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].url, 'https://example.com/api/order');

  const cleared = await client.clear('client-test');
  assert.equal(cleared, true);
  assert.equal(await queue.size(), 0);
});
