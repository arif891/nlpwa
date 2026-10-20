import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock navigator with Badging API
let mockBadge = null;
let setBadgeCalls = [];
let clearBadgeCalls = [];

Object.defineProperty(globalThis, 'navigator', {
  value: {
    onLine: true,
    setAppBadge: async (val) => {
      setBadgeCalls.push(val);
      mockBadge = val ?? 1;
    },
    clearAppBadge: async () => {
      clearBadgeCalls.push(true);
      mockBadge = 0;
    },
    storage: {
      persisted: async () => false,
      persist: async () => true,
    },
  },
  configurable: true,
  writable: true,
});

const {
  isBadgingSupported,
  setAppBadge,
  clearAppBadge,
} = await import('../src/client/badge.js');

const {
  nlpwa,
  getState,
} = await import('../src/client/status-store.js');

const {
  createManifest,
} = await import('../src/cli/core/icons.js');

const {
  isShareTargetRequest,
  handleShareTarget,
  getLatestSharedData,
} = await import('../src/sw/features/share-target.js');

const {
  handlePush,
  handleNotificationClick,
} = await import('../src/sw/events/push.js');

test('badging: isBadgingSupported detects navigator.setAppBadge', () => {
  assert.equal(isBadgingSupported(), true);
});

test('badging: setAppBadge calls navigator.setAppBadge with count and dot', async () => {
  setBadgeCalls = [];
  const res1 = await setAppBadge(5);
  assert.equal(res1, true);
  assert.equal(setBadgeCalls[0], 5);
  assert.equal(mockBadge, 5);

  const res2 = await setAppBadge();
  assert.equal(res2, true);
  assert.equal(setBadgeCalls.length, 2);
  assert.equal(setBadgeCalls[1], undefined);
});

test('badging: setAppBadge(0) and clearAppBadge clears the badge', async () => {
  clearBadgeCalls = [];
  const res1 = await setAppBadge(0);
  assert.equal(res1, true);
  assert.equal(clearBadgeCalls.length, 1);
  assert.equal(mockBadge, 0);

  const res2 = await clearAppBadge();
  assert.equal(res2, true);
  assert.equal(clearBadgeCalls.length, 2);
});

test('badging: nlpwa.setBadge and nlpwa.clearBadge update reactive state store', async () => {
  await nlpwa.setBadge(9);
  assert.equal(getState().badgeCount, 9);

  await nlpwa.clearBadge();
  assert.equal(getState().badgeCount, 0);
});

test('push & badge: handlePush sets and clears badge based on push payload', async () => {
  let waitPromise = null;
  const mockEvent = {
    data: {
      json: () => ({ badge: 7, title: 'New Message' }),
      text: () => '',
    },
    waitUntil: (p) => { waitPromise = p; },
  };

  setBadgeCalls = [];
  handlePush({})(mockEvent);
  await waitPromise;
  assert.equal(setBadgeCalls.includes(7), true);

  // Clear badge when badge: 0
  const clearEvent = {
    data: {
      json: () => ({ badge: 0 }),
      text: () => '',
    },
    waitUntil: (p) => { waitPromise = p; },
  };
  clearBadgeCalls = [];
  handlePush({})(clearEvent);
  await waitPromise;
  assert.equal(clearBadgeCalls.length > 0, true);
});

test('push & badge: handleNotificationClick clears badge by default', () => {
  clearBadgeCalls = [];
  const notifEvent = {
    notification: {
      close: () => {},
      data: { url: '/' },
    },
    waitUntil: () => {},
  };

  handleNotificationClick({})(notifEvent);
  assert.equal(clearBadgeCalls.length > 0, true);
});

test('manifest: createManifest generates launch_handler and shortcuts', () => {
  const manifest = createManifest({
    name: 'Awesome Task App',
    shortName: 'Tasks',
  });

  assert.equal(manifest.name, 'Awesome Task App');
  assert.deepEqual(manifest.launch_handler, { client_mode: 'navigate-existing' });
  assert.equal(Array.isArray(manifest.shortcuts), true);
  assert.equal(manifest.shortcuts[0].name, 'Open Tasks');
  assert.equal(manifest.shortcuts[0].url, '/');
});

test('manifest: createManifest includes custom shareTarget and fileHandlers when provided', () => {
  const shareTarget = {
    action: '/_share-target',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { title: 't', text: 'txt', url: 'u' },
  };
  const fileHandlers = [{ action: '/open', accept: { 'text/plain': ['.txt'] } }];

  const manifest = createManifest({
    shareTarget,
    fileHandlers,
  });

  assert.deepEqual(manifest.share_target, shareTarget);
  assert.deepEqual(manifest.file_handlers, fileHandlers);
});

test('share target: isShareTargetRequest detects matching action URL', () => {
  const req1 = { url: 'https://example.com/_share-target', method: 'POST' };
  const req2 = { url: 'https://example.com/other-page', method: 'GET' };
  const config = { shareTarget: { action: '/_share-target' } };

  assert.equal(isShareTargetRequest(req1, config), true);
  assert.equal(isShareTargetRequest(req2, config), false);
});

test('share target: handleShareTarget caches data and redirects with 303', async () => {
  // Mock caches
  const cacheStorage = new Map();
  globalThis.caches = {
    open: async (name) => ({
      put: async (req, resp) => {
        cacheStorage.set(req.url, resp);
      },
      match: async (url) => cacheStorage.get(url) || null,
      delete: async (url) => cacheStorage.delete(url),
    }),
  };

  const req = {
    url: 'https://example.com/_share-target?title=MyTitle&text=Hello&url=https://xyz.com',
    method: 'GET',
  };

  const event = { request: req };
  const config = {
    shareTarget: {
      action: '/_share-target',
      redirectUrl: '/?shared=1',
    },
  };

  const response = await handleShareTarget(event, config);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'https://example.com/?shared=1');

  // Verify data can be retrieved and is cleared upon retrieval
  const shared = await getLatestSharedData();
  assert.ok(shared);
  assert.equal(shared.title, 'MyTitle');
  assert.equal(shared.text, 'Hello');
  assert.equal(shared.url, 'https://xyz.com');

  // Subsequent call yields null because it was consumed
  const sharedAgain = await getLatestSharedData();
  assert.equal(sharedAgain, null);
});
