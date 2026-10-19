import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent } from './helpers/fake-env.js';
import { cacheFirst, networkFirst, networkOnly, staleWhileRevalidate } from '../src/sw/fetch/strategies/index.js';

test('plugin hooks: requestWillFetch modifies outgoing network Request', async () => {
  let receivedAuthHeader = null;
  const caches = setupEnv(async (request) => {
    receivedAuthHeader = request.headers.get('Authorization');
    return new Response('authenticated-data');
  });

  const plugin = {
    requestWillFetch: async ({ request }) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', 'Bearer secret-token-123');
      return new Request(request.url, { headers });
    },
  };

  const response = await networkFirst(req('/api/user'), fakeEvent(), {
    plugins: [plugin],
  });

  assert.equal(receivedAuthHeader, 'Bearer secret-token-123');
  assert.equal(await response.text(), 'authenticated-data');
});

test('plugin hooks: cachedResponseWillBeUsed returning null forces cache miss to network', async () => {
  let networkCalls = 0;
  const caches = setupEnv(async () => {
    networkCalls++;
    return new Response('fresh-from-network');
  });

  // Pre-populate runtime cache with an entry
  const runtime = await caches.open('runtime');
  await runtime.put(req('/data.json'), new Response('stale-data'));

  // Plugin that invalidates cached response
  const plugin = {
    cachedResponseWillBeUsed: async ({ cachedResponse }) => {
      // Reject stale cached response
      return null;
    },
  };

  const response = await cacheFirst(req('/data.json'), fakeEvent(), {
    plugins: [plugin],
  });

  // Since cachedResponseWillBeUsed returned null, cacheFirst went to network
  assert.equal(networkCalls, 1);
  assert.equal(await response.text(), 'fresh-from-network');
});

test('plugin hooks: cachedResponseWillBeUsed can modify cached response headers', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');
  await runtime.put(req('/profile'), new Response('cached profile', {
    headers: { 'Content-Type': 'text/plain' },
  }));

  const plugin = {
    cachedResponseWillBeUsed: async ({ cachedResponse }) => {
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Custom-Plugin', 'verified');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    },
  };

  const response = await cacheFirst(req('/profile'), fakeEvent(), {
    plugins: [plugin],
  });

  assert.equal(await response.text(), 'cached profile');
  assert.equal(response.headers.get('X-Custom-Plugin'), 'verified');
});

test('plugin hooks: cacheWillUpdate returning null/false skips storing in runtime cache', async () => {
  const caches = setupEnv(async () => {
    return new Response('do-not-cache-this');
  });

  const plugin = {
    cacheWillUpdate: async ({ response }) => {
      const bodyText = await response.clone().text();
      if (bodyText.includes('do-not-cache')) {
        return null; // Deny caching
      }
      return response;
    },
  };

  const event = fakeEvent();
  const response = await networkFirst(req('/temp'), event, {
    plugins: [plugin],
  });
  await event.settle();

  assert.equal(await response.text(), 'do-not-cache-this');

  // Verify that the entry was NOT stored in the runtime cache
  const runtime = await caches.open('runtime');
  const cached = await runtime.match(req('/temp'));
  assert.equal(cached, undefined);
});

test('plugin hooks: direct route hook functions work without wrapping in plugins array', async () => {
  const caches = setupEnv(async () => new Response('network payload'));

  let hookFired = false;
  const event = fakeEvent();
  await networkFirst(req('/direct-hook'), event, {
    cacheWillUpdate: async ({ response }) => {
      hookFired = true;
      return response;
    },
  });
  await event.settle();

  assert.equal(hookFired, true);
  const runtime = await caches.open('runtime');
  assert.ok(await runtime.match(req('/direct-hook')));
});

test('plugin hooks: fetchDidFail and cacheDidUpdate fire on their respective events', async () => {
  let failFired = false;
  setupEnv(async () => {
    throw new TypeError('Network down');
  });

  const failPlugin = {
    fetchDidFail: async ({ error }) => {
      failFired = true;
      assert.ok(error instanceof TypeError);
    },
  };

  await networkFirst(req('/fail'), fakeEvent(), {
    plugins: [failPlugin],
  });
  assert.equal(failFired, true);

  // Now test cacheDidUpdate on successful cache write
  const successCaches = setupEnv(async () => new Response('success'));
  let updateFired = false;
  const updatePlugin = {
    cacheDidUpdate: async ({ cacheName }) => {
      updateFired = true;
      assert.equal(cacheName, 'runtime');
    },
  };

  const event = fakeEvent();
  await networkFirst(req('/write'), event, {
    plugins: [updatePlugin],
  });
  await event.settle();

  assert.equal(updateFired, true);
});
