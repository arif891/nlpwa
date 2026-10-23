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
  withStore,
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

test('sync queue: legitimate HTML response (e.g. HTMX) with 200 OK succeeds and is removed without flagging authRequired', async () => {
  const queue = new SyncQueue('htmx-test');
  await queue.push(new Request('https://example.com/api/comments', { method: 'POST', body: 'comment text' }));

  // Mock HTMX endpoint returning HTML fragment with 200 OK and redirected = false
  const htmxResponse = new Response('<div id="comment-42">New comment</div>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  Object.defineProperty(htmxResponse, 'redirected', { value: false });

  const result = await queue.replayAll({ fetchImpl: async () => htmxResponse });

  assert.equal(result.successCount, 1, 'HTMX 200 HTML response must succeed');
  assert.equal(result.failedCount, 0);
  assert.equal(await queue.size(), 0, 'Completed HTMX mutation must be dequeued');
});

test('sync queue: authRequired items are excluded from default replayAll and can be resumed with retryAuthRequired', async () => {
  const queue = new SyncQueue('auth-retry-test');
  const id = await queue.push(new Request('https://example.com/api/protected-action', { method: 'POST' }));

  // Simulate first replay getting a login redirect
  const redirectResponse = new Response('<html>Login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(redirectResponse, 'redirected', { value: true });
  Object.defineProperty(redirectResponse, 'url', { value: 'https://example.com/login' });

  await queue.replayAll({ fetchImpl: async () => redirectResponse });

  const authItems = await queue.getAuthRequired();
  assert.equal(authItems.length, 1);
  assert.equal(authItems[0].authRequired, true);

  // Subsequent background replayAll must SKIP this item (excludeAuthRequired: true by default)
  let fetchCalled = false;
  const secondResult = await queue.replayAll({
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response('ok');
    },
  });

  assert.equal(fetchCalled, false, 'authRequired item must NOT be retried until re-authenticated');
  assert.equal(secondResult.successCount, 0);

  // User logs in and application calls retryAuthRequired
  const resetCount = await queue.retryAuthRequired(id);
  assert.equal(resetCount, 1);

  // Now replayAll will retry the mutation
  const thirdResult = await queue.replayAll({
    fetchImpl: async () => new Response('created', { status: 201 }),
  });
  assert.equal(thirdResult.successCount, 1);
  assert.equal(await queue.size(), 0);
});

test('sync client: destroy cleans up message event listener on navigator.serviceWorker', () => {
  const listeners = [];
  const fakeSW = {
    addEventListener: (t, fn) => listeners.push(fn),
    removeEventListener: (t, fn) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  const origSW = globalThis.navigator?.serviceWorker;
  if (!globalThis.navigator) globalThis.navigator = {};
  globalThis.navigator.serviceWorker = fakeSW;

  const client = new SyncClient();
  assert.equal(listeners.length, 1);

  client.destroy();
  assert.equal(listeners.length, 0);

  if (origSW) {
    globalThis.navigator.serviceWorker = origSW;
  } else {
    delete globalThis.navigator.serviceWorker;
  }
});

test('sync plugin: handleFetch routes non-GET mutation to networkOnly and invokes fetchDidFail on network error', async () => {
  const { handleFetch } = await import('../src/sw/fetch/index.js');
  const syncPlugin = new BackgroundSyncPlugin({ queueName: 'form-posts' });

  // Init config with a plugin on a route matching POST
  setupEnv(
    () => {
      throw new Error('Network offline');
    },
    {
      routes: [
        {
          match: '/api/submit',
          plugins: [syncPlugin],
        },
      ],
    }
  );

  let respondedWithPromise = null;
  const postReq = new Request('https://example.com/api/submit', {
    method: 'POST',
    body: JSON.stringify({ action: 'test' }),
    headers: { 'Content-Type': 'application/json' },
  });

  const event = {
    request: postReq,
    respondWith(p) {
      respondedWithPromise = p;
    },
    waitUntil(p) {},
  };

  handleFetch(event);
  assert.ok(respondedWithPromise, 'handleFetch must not return early on POST when plugins/routes match');

  const response = await respondedWithPromise;
  assert.equal(response.status, 503);
  assert.equal(await syncPlugin.queue.size(), 1, 'Failed POST request must be enqueued');
});

test('sync plugin: standalone fetch listener catches failed mutations when not handled by NLPWA', async () => {
  const listeners = {};
  globalThis.self = {
    location: { origin: 'https://example.com' },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
  };

  globalThis.fetch = async () => {
    throw new Error('Failed to fetch (offline)');
  };

  const plugin = new BackgroundSyncPlugin({ queueName: 'standalone-q' });
  assert.ok(listeners['fetch'] && listeners['fetch'].length > 0, 'Standalone fetch listener registered');

  const fetchHandler = listeners['fetch'][0];
  let respondedWithPromise = null;
  const postReq = new Request('https://example.com/api/orders', {
    method: 'POST',
    body: JSON.stringify({ orderId: 123 }),
  });

  const fakeEv = {
    request: postReq,
    respondWith(p) {
      respondedWithPromise = p;
    },
    waitUntil(p) {},
  };

  fetchHandler(fakeEv);
  assert.ok(respondedWithPromise, 'Standalone handler must call respondWith');

  await assert.rejects(respondedWithPromise, /Failed to fetch/);
  assert.equal(await plugin.queue.size(), 1, 'Mutation queued in standalone mode');
});

test('sync queue: stripAuthHeaders option strips Authorization headers from IndexedDB', async () => {
  const queue = new SyncQueue('strip-auth-q', { stripAuthHeaders: true });
  const req = new Request('https://example.com/api/sensitive', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret-token-12345',
      'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      'X-Custom-Header': 'keep-me',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ item: 'data' }),
  });

  const id = await queue.push(req);
  const items = await queue.getAll();
  const stored = items.find((i) => i.id === id);

  assert.ok(stored, 'Item must be stored in IDB');
  const storedHeaders = new Headers(stored.headers);
  assert.equal(storedHeaders.has('authorization'), false, 'Authorization header must be stripped');
  assert.equal(storedHeaders.has('proxy-authorization'), false, 'Proxy-Authorization header must be stripped');
  assert.equal(storedHeaders.get('x-custom-header'), 'keep-me', 'Other headers must be preserved');
  assert.equal(storedHeaders.get('content-type'), 'application/json', 'Content-Type must be preserved');
});

test('sync queue: replayAll can inject/re-attach fresh credentials at replay time', async () => {
  const queue = new SyncQueue('reauth-replay-q', { stripAuthHeaders: true });
  const req = new Request('https://example.com/api/resource', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer old-expired-token',
    },
  });

  await queue.push(req);

  let capturedAuth = null;
  const result = await queue.replayAll({
    headers: {
      'Authorization': 'Bearer fresh-valid-token-999',
    },
    fetchImpl: async (r) => {
      capturedAuth = r.headers.get('authorization');
      return new Response('ok', { status: 200 });
    },
  });

  assert.equal(result.successCount, 1);
  assert.equal(capturedAuth, 'Bearer fresh-valid-token-999', 'Fresh authorization header must be injected at replay time');
});

test('sync queue: retryAuthRequired updates stored record with fresh authorization headers', async () => {
  const queue = new SyncQueue('update-auth-q');
  const req = new Request('https://example.com/api/action', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer expired-token' },
  });

  const id = await queue.push(req);

  // Replay fails with 401
  await queue.replayAll({
    fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
  });

  const authItems = await queue.getAuthRequired();
  assert.equal(authItems.length, 1);
  assert.equal(authItems[0].authRequired, true);

  // User logs in and passes fresh token to retryAuthRequired
  await queue.retryAuthRequired(id, {
    headers: { 'Authorization': 'Bearer refreshed-token-777' },
  });

  let replayedAuth = null;
  const result = await queue.replayAll({
    fetchImpl: async (r) => {
      replayedAuth = r.headers.get('authorization');
      return new Response('ok', { status: 200 });
    },
  });

  assert.equal(result.successCount, 1);
  assert.equal(replayedAuth, 'Bearer refreshed-token-777', 'Replayed request must use the refreshed token attached on retryAuthRequired');
});

test('sync: preserves credentials and mode across serialization', async () => {
  const original = new Request('https://example.com/api/orders', {
    method: 'POST',
    credentials: 'include',
    mode: 'cors',
  });

  const serialized = await serializeRequest(original, { queueName: 'cred-test' });
  assert.equal(serialized.credentials, 'include');
  assert.equal(serialized.mode, 'cors');

  const restored = deserializeRequest(serialized);
  assert.equal(restored.credentials, 'include');
  assert.equal(restored.mode, 'cors');
});

test('sync queue: replayAll returns replayed and remaining aliases', async () => {
  const queue = new SyncQueue('alias-test');
  await queue.push(new Request('https://example.com/api/test', { method: 'POST' }));

  const result = await queue.replayAll({
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  assert.equal(result.successCount, 1);
  assert.equal(result.replayed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.remainingCount, 0);
});

test('sync client: emits error and discard events on replay failures', async () => {
  const client = new SyncClient('event-test');
  const queue = new SyncQueue('event-test', { maxRetries: 1 });
  await queue.push(new Request('https://example.com/api/fail-event', { method: 'POST' }));

  let errorEvent = null;
  let discardEvent = null;
  client.on('error', (e) => { errorEvent = e; });
  client.on('discard', (e) => { discardEvent = e; });

  await queue.replayAll({
    fetchImpl: async () => new Response('Internal Server Error', { status: 500 }),
    onReplayFail: (item, err) => {
      client._emit('failed', { queue: 'event-test', id: item.id, url: item.url, error: err });
      client._emit('error', { queue: 'event-test', id: item.id, url: item.url, error: err });
    },
    onReplayDiscard: (item, reason) => {
      client._emit('discard', { queue: 'event-test', id: item.id, url: item.url, reason });
    },
  });

  assert.ok(errorEvent, 'error event fired');
  assert.ok(discardEvent, 'discard event fired');
  assert.equal(discardEvent.reason, 'max_retries_exceeded');
});

test('sync client: retryDeadLetter and retryAuthRequired accept flexible parameter ordering', async () => {
  const client = new SyncClient('flex-test');
  const queue = new SyncQueue('flex-test');

  const id = await queue.push(new Request('https://example.com/api/auth-req', { method: 'POST' }));
  // Mark authRequired
  await queue.replayAll({ fetchImpl: async () => new Response('Unauthorized', { status: 401 }) });

  // 1. Call retryAuthRequired with (queueName, id, options)
  const reset1 = await client.retryAuthRequired('flex-test', id, { headers: { 'Authorization': 'Bearer test1' } });
  assert.equal(reset1, 1);

  // Mark authRequired again
  await queue.replayAll({ fetchImpl: async () => new Response('Unauthorized', { status: 401 }) });

  // 2. Call retryAuthRequired with (id, queueName, options)
  const reset2 = await client.retryAuthRequired(id, 'flex-test', { headers: { 'Authorization': 'Bearer test2' } });
  assert.equal(reset2, 1);
});

test('sync queue: POST-Redirect-GET (e.g. 303 to confirmation URL) succeeds and does not duplicate', async () => {
  const queue = new SyncQueue('prg-redirect');
  await queue.push(new Request('https://example.com/api/orders', { method: 'POST', body: 'order-123' }));

  // Mock 303 redirect to /orders/confirmation
  const fake303 = new Response('Redirecting', {
    status: 303,
    headers: { 'Location': 'https://example.com/orders/confirmation' },
  });
  Object.defineProperty(fake303, 'redirected', { value: true });
  Object.defineProperty(fake303, 'url', { value: 'https://example.com/orders/confirmation' });

  const result = await queue.replayAll({ fetchImpl: async () => fake303 });
  assert.equal(result.successCount, 1, 'Non-login redirect should succeed');
  assert.equal(result.failedCount, 0);
  assert.equal(await queue.size(), 0, 'Processed mutation should be removed from queue');
});

test('sync queue: corrupted item throwing in deserializeRequest is moved to dead-letter without blocking queue', async () => {
  const queue = new SyncQueue('corrupt-unblock');
  // Store an invalid/corrupted item directly in IDB
  const badId = await queue.push(new Request('https://example.com/api/valid1', { method: 'POST' }));
  const goodId = await queue.push(new Request('https://example.com/api/valid2', { method: 'POST' }));

  // Corrupt badId's url to an invalid scheme that causes new Request() to throw
  await withStore('readwrite', (store) => {
    return new Promise((resolve) => {
      const getReq = store.get(badId);
      getReq.onsuccess = () => {
        const item = getReq.result;
        item.url = '::invalid-url::';
        store.put(item);
        resolve();
      };
    });
  });

  const successfulUrls = [];
  const discardedReasons = [];
  const result = await queue.replayAll({
    fetchImpl: async (req) => {
      successfulUrls.push(req.url);
      return new Response('ok', { status: 200 });
    },
    onReplayDiscard: (item, reason) => {
      discardedReasons.push({ id: item.id, reason });
    },
  });

  assert.equal(result.successCount, 1, 'Good item succeeded');
  assert.equal(successfulUrls.length, 1);
  assert.equal(successfulUrls[0], 'https://example.com/api/valid2');
  assert.equal(discardedReasons.length, 1);
  assert.equal(discardedReasons[0].id, badId);
  assert.equal(discardedReasons[0].reason, 'deserialization_error');

  const deadLetters = await queue.getDeadLetter();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].id, badId);
  assert.equal(deadLetters[0].deadLetterReason, 'deserialization_error');
});

test('sync queue: expired items are moved to dead-letter store instead of vanishing silently', async () => {
  const queue = new SyncQueue('expired-dead-letter', { maxRetentionMs: 1000 });
  const id = await queue.push(new Request('https://example.com/api/expiring', { method: 'POST' }), {
    timestamp: Date.now() - 5000, // 5s ago (exceeds 1s retention)
  });

  // Active items should be 0
  assert.equal(await queue.size(), 0);

  // But item is NOT lost: it is preserved in dead-letter store with reason 'expired'
  const deadLetters = await queue.getDeadLetter();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].id, id);
  assert.equal(deadLetters[0].deadLetter, true);
  assert.equal(deadLetters[0].deadLetterReason, 'expired');
});

test('sw plugin: replay() forwards onReplayFail to caller options', async () => {
  const plugin = new BackgroundSyncPlugin({ queueName: 'sw-fail-forward' });
  await plugin.queue.push(new Request('https://example.com/api/fail-check', { method: 'POST' }));

  let forwardedError = null;
  let forwardedItem = null;

  await plugin.replay({
    fetchImpl: async () => new Response('Internal Server Error', { status: 500 }),
    onReplayFail: (item, err) => {
      forwardedItem = item;
      forwardedError = err;
    },
  });

  assert.ok(forwardedItem, 'onReplayFail was forwarded item');
  assert.equal(forwardedItem.url, 'https://example.com/api/fail-check');
  assert.ok(forwardedError, 'onReplayFail was forwarded error response');
  assert.equal(forwardedError.status, 500);
});

test('sync idb: uses standard Idempotency-Key header and enforces maxBodyBytes cap', async () => {
  // 1. Standard Idempotency-Key header
  const req = new Request('https://example.com/api/idem', { method: 'POST', body: 'payload' });
  const serialized = await serializeRequest(req);
  const deserialized = deserializeRequest(serialized);
  assert.ok(deserialized.headers.has('idempotency-key'), 'Sets standard Idempotency-Key');
  assert.equal(deserialized.headers.get('idempotency-key'), serialized.idempotencyKey);

  // 2. Body size cap enforcement
  const bigBody = new Uint8Array(1024 * 1024 * 2); // 2MB
  const bigReq = new Request('https://example.com/api/big', { method: 'POST', body: bigBody });

  await assert.rejects(
    async () => {
      await serializeRequest(bigReq, {}, { maxBodyBytes: 1024 * 1024 }); // 1MB limit
    },
    /exceeds maximum allowed size/,
    'Rejects payloads exceeding maxBodyBytes'
  );
});
