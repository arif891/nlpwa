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

test('sync queue: replayAll stops loop on network error and preserves retryCount without discarding', async () => {
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

  // Network failures do NOT increment retryCount toward eviction
  const items = await queue.getAll();
  assert.equal(items[0].retryCount, 0);
});

test('sync queue: drops request after exceeding maxRetries on server errors', async () => {
  const queue = new SyncQueue('max-retries', { maxRetries: 2 });
  await queue.push(new Request('https://example.com/api/fail-perm', { method: 'POST' }));

  // First server failure (HTTP 500)
  await queue.replayAll({ fetchImpl: async () => new Response('Internal Server Error', { status: 500 }) });
  assert.equal(await queue.size(), 1);

  // Second server failure -> exceeds maxRetries (2) -> discarded
  await queue.replayAll({ fetchImpl: async () => new Response('Internal Server Error', { status: 500 }) });
  assert.equal(await queue.size(), 0);
});

test('sync queue: preserves 401/403 auth errors without discarding user edits', async () => {
  const queue = new SyncQueue('auth-error');
  await queue.push(new Request('https://example.com/api/auth-edit', { method: 'POST' }));

  await queue.replayAll({ fetchImpl: async () => new Response('Unauthorized', { status: 401 }) });
  assert.equal(await queue.size(), 1);

  const items = await queue.getAll();
  assert.equal(items[0].authRequired, true);
  assert.equal(items[0].lastStatus, 401);
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

test('sync queue: session-expired redirect preserves mutation and sets authRequired', async () => {
  const queue = new SyncQueue('redirect-protection');
  await queue.push(new Request('https://example.com/api/post-comment', { method: 'POST', body: 'hello' }));

  // Mock server returning redirect (redirected: true, status 200 HTML login page)
  const fakeRedirectResponse = new Response('<html>Login Page</html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  Object.defineProperty(fakeRedirectResponse, 'redirected', { value: true });
  Object.defineProperty(fakeRedirectResponse, 'url', { value: 'https://example.com/login' });

  const result = await queue.replayAll({ fetchImpl: async () => fakeRedirectResponse });

  assert.equal(result.failedCount, 1);
  assert.equal(result.successCount, 0);
  assert.equal(await queue.size(), 1, 'Mutation must NOT be deleted when server redirects to login');

  const items = await queue.getAll();
  assert.equal(items[0].authRequired, true);
  assert.equal(items[0].redirected, true);
});

test('sync queue: 4xx unprocessable/conflict errors are moved to dead-letter store instead of lost', async () => {
  const queue = new SyncQueue('dead-letter-test');
  const id = await queue.push(new Request('https://example.com/api/conflict', { method: 'POST' }));

  // Replay returns 409 Conflict
  await queue.replayAll({
    fetchImpl: async () => new Response('Conflict', { status: 409 }),
  });

  // Active queue size should now be 0
  assert.equal(await queue.size(), 0);

  // Dead-letter store must retain the failed mutation
  const deadLetters = await queue.getDeadLetter();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].id, id);
  assert.equal(deadLetters[0].deadLetter, true);
  assert.equal(deadLetters[0].lastStatus, 409);

  // Client can retry dead-letter mutation after fixing conflict
  const restored = await queue.retryDeadLetter(id);
  assert.equal(restored, true);
  assert.equal(await queue.size(), 1);

  const activeItems = await queue.getAll();
  assert.equal(activeItems[0].deadLetter, false);
});

test('sync queue: clearOnLogout / clearAll purges all requests across all queues', async () => {
  const q1 = new SyncQueue('q1');
  const q2 = new SyncQueue('q2');

  await q1.push(new Request('https://example.com/api/q1', { method: 'POST' }));
  await q2.push(new Request('https://example.com/api/q2', { method: 'POST' }));

  assert.equal(await q1.size(), 1);
  assert.equal(await q2.size(), 1);

  const client = new SyncClient('q1');
  await client.clearOnLogout();

  assert.equal(await q1.size(), 0);
  assert.equal(await q2.size(), 0);
});

