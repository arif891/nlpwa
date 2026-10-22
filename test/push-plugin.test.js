import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import {
  isPushSupported,
  getPushPermission,
  urlBase64ToUint8Array,
  subscribePush,
  unsubscribePush,
  PushClient,
  pushClient,
  PushPlugin,
} from '../src/plugins/push/index.js';

test.beforeEach(() => {
  setupEnv(() => new Response('ok'));
});

test('push: urlBase64ToUint8Array converts URL-safe base64 string correctly', () => {
  // A valid dummy URL-safe base64 string
  const base64Key = 'BCc9Y-wX2q7v-Z1A_bC3dE5fG7hI9jK0lM1nO2pQ3rS4tU5vW6xY7z8';
  const u8 = urlBase64ToUint8Array(base64Key);
  assert.ok(u8 instanceof Uint8Array);
  assert.ok(u8.length > 0);

  // Throws on empty or non-string
  assert.throws(() => urlBase64ToUint8Array(''), /non-empty string/);
  assert.throws(() => urlBase64ToUint8Array(null), /non-empty string/);
});

test('push: isPushSupported returns false in mock env without PushManager', () => {
  assert.equal(isPushSupported(), false);
  assert.equal(getPushPermission(), 'unsupported');
});

test('push: subscribePush returns unsupported when PushManager or Notification missing', async () => {
  const result = await subscribePush({ vapidPublicKey: 'BCc9Y-wX2q7v' });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'unsupported');
  assert.equal(result.permission, 'unsupported');
});

function setMockNavigator(val) {
  Object.defineProperty(globalThis, 'navigator', {
    value: val,
    configurable: true,
    writable: true,
  });
}

function setMockWindow(val) {
  Object.defineProperty(globalThis, 'window', {
    value: val,
    configurable: true,
    writable: true,
  });
}

test('push: subscribePush succeeds with progressive enhancement in supported env', async () => {
  let subscribedKey = null;
  let userVisibleOption = null;

  const mockSub = {
    endpoint: 'https://push.example.com/sub/123',
    toJSON: () => ({ endpoint: 'https://push.example.com/sub/123' }),
    unsubscribe: async () => true,
  };

  const fakeReg = {
    pushManager: {
      subscribe: async ({ userVisibleOnly, applicationServerKey }) => {
        userVisibleOption = userVisibleOnly;
        subscribedKey = applicationServerKey;
        return mockSub;
      },
      getSubscription: async () => null,
    },
  };

  const origWindow = globalThis.window;
  const origNav = globalThis.navigator;
  setMockWindow(globalThis);
  setMockNavigator({ serviceWorker: { ready: Promise.resolve(fakeReg) } });

  // Mock Notification and PushManager
  globalThis.Notification = {
    permission: 'default',
    requestPermission: async () => {
      globalThis.Notification.permission = 'granted';
      return 'granted';
    },
  };
  globalThis.PushManager = class PushManager {};

  try {
    assert.equal(isPushSupported(), true);
    assert.equal(getPushPermission(), 'default');

    const result = await subscribePush({
      vapidPublicKey: 'BCc9Y-wX2q7v-Z1A_bC3dE5fG7hI9jK0lM1nO2pQ3rS4tU5vW6xY7z8',
      registration: fakeReg,
    });

    assert.equal(result.success, true);
    assert.equal(result.permission, 'granted');
    assert.equal(userVisibleOption, true);
    assert.ok(subscribedKey instanceof Uint8Array);
    assert.deepEqual(result.json, { endpoint: 'https://push.example.com/sub/123' });
  } finally {
    delete globalThis.Notification;
    delete globalThis.PushManager;
    setMockWindow(origWindow);
    setMockNavigator(origNav);
  }
});

test('push: subscribePush returns permission_denied if user rejects notification prompt', async () => {
  const origWindow = globalThis.window;
  const origNav = globalThis.navigator;
  setMockWindow(globalThis);
  setMockNavigator({ serviceWorker: {} });

  globalThis.Notification = {
    permission: 'default',
    requestPermission: async () => 'denied',
  };
  globalThis.PushManager = class {};

  try {
    const result = await subscribePush({
      vapidPublicKey: 'BCc9Y-wX2q7v-Z1A_bC3dE5fG7hI9jK0lM1nO2pQ3rS4tU5vW6xY7z8',
    });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'permission_denied');
    assert.equal(result.permission, 'denied');
  } finally {
    delete globalThis.Notification;
    delete globalThis.PushManager;
    setMockWindow(origWindow);
    setMockNavigator(origNav);
  }
});

test('push: unsubscribePush returns true when unsubscribed', async () => {
  let unsubCalled = false;
  const fakeReg = {
    pushManager: {
      getSubscription: async () => ({
        unsubscribe: async () => {
          unsubCalled = true;
          return true;
        },
      }),
    },
  };

  const origWindow = globalThis.window;
  const origNav = globalThis.navigator;
  setMockWindow(globalThis);
  setMockNavigator({ serviceWorker: { ready: Promise.resolve(fakeReg) } });

  globalThis.Notification = { permission: 'granted' };
  globalThis.PushManager = class {};

  try {
    const ok = await unsubscribePush({ registration: fakeReg });
    assert.equal(ok, true);
    assert.equal(unsubCalled, true);
  } finally {
    delete globalThis.Notification;
    delete globalThis.PushManager;
    setMockWindow(origWindow);
    setMockNavigator(origNav);
  }
});



test('push: PushPlugin handles incoming push and displays notification', async () => {
  let shownTitle = null;
  let shownOptions = null;
  let customPushPayload = null;

  globalThis.self = {
    registration: {
      showNotification: async (title, options) => {
        shownTitle = title;
        shownOptions = options;
      },
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url) => ({ url }),
    },
  };

  const plugin = new PushPlugin({
    defaultUrl: '/inbox',
    onPush: (event, payload) => {
      customPushPayload = payload;
    },
  });

  let waitPromise = null;
  const fakeEvent = {
    data: {
      json: () => ({ title: 'New Message', body: 'Hello Arif', url: '/chat/42' }),
    },
    waitUntil: (p) => { waitPromise = p; },
  };

  plugin.onPush(fakeEvent);
  await waitPromise;

  assert.equal(shownTitle, 'New Message');
  assert.equal(shownOptions.body, 'Hello Arif');
  assert.equal(shownOptions.data.url, '/chat/42');
  assert.deepEqual(customPushPayload, { title: 'New Message', body: 'Hello Arif', url: '/chat/42' });
});

test('push: PushPlugin handles notificationclick action button and custom click', async () => {
  let actionFired = false;
  let closed = false;

  const plugin = new PushPlugin({
    actions: {
      'view-details': (event) => {
        actionFired = true;
      },
    },
  });

  const fakeClickEvent = {
    action: 'view-details',
    notification: {
      close: () => { closed = true; },
      data: { url: '/details' },
    },
    waitUntil: () => {},
  };

  plugin.onNotificationClick(fakeClickEvent);
  assert.equal(closed, true);
  assert.equal(actionFired, true);
});
