import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import {
  isPeriodicSyncSupported,
  getPeriodicSyncPermission,
  registerPeriodicSync,
  unregisterPeriodicSync,
  getPeriodicSyncTags,
  PeriodicSyncClient,
  periodicSyncClient,
  PeriodicSyncPlugin,
  PERIODIC_SYNC_CONSTANTS,
  PERIODIC_SYNC_STRATEGIES,
  BackgroundSyncPlugin,
} from '../src/plugins/sync/index.js';
import { handleSync } from '../src/sw/events/sync.js';
import { initConfig } from '../src/sw/config/index.js';

test.beforeEach(() => {
  setupEnv(() => new Response('ok'));
});

test('periodic sync: isPeriodicSyncSupported returns false in default mock env', () => {
  assert.equal(isPeriodicSyncSupported(), false);
});

test('periodic sync: registerPeriodicSync falls back progressively when native periodicSync is unavailable', async () => {
  let syncCount = 0;

  const result = await registerPeriodicSync('sync-articles', {
    minInterval: 1000,
    onSync: async () => {
      syncCount++;
    },
  });

  assert.equal(result.registered, true);
  assert.equal(result.strategy, PERIODIC_SYNC_STRATEGIES.FALLBACK);
  assert.equal(result.tag, 'sync-articles');

  // Triggered on registration
  assert.equal(syncCount, 1);

  const tags = await getPeriodicSyncTags();
  assert.ok(tags.includes('sync-articles'));

  // Clean up
  await unregisterPeriodicSync('sync-articles');
  const tagsAfter = await getPeriodicSyncTags();
  assert.ok(!tagsAfter.includes('sync-articles'));
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

test('periodic sync: registerPeriodicSync uses native strategy when periodicSync is supported', async () => {
  let registeredTag = null;
  let registeredOptions = null;

  const fakeReg = {
    periodicSync: {
      register: async (tag, options) => {
        registeredTag = tag;
        registeredOptions = options;
      },
      unregister: async (tag) => {},
      getTags: async () => [tag],
    },
  };

  const origWindow = globalThis.window;
  const origNav = globalThis.navigator;
  setMockWindow(globalThis);
  setMockNavigator({ serviceWorker: { ready: Promise.resolve(fakeReg) } });

  // Mock ServiceWorkerRegistration.prototype.periodicSync
  globalThis.ServiceWorkerRegistration = function () {};
  globalThis.ServiceWorkerRegistration.prototype.periodicSync = {};

  try {
    assert.equal(isPeriodicSyncSupported(), true);

    const result = await registerPeriodicSync('sync-feed', {
      minInterval: 43200000,
      registration: fakeReg,
    });

    assert.equal(result.registered, true);
    assert.equal(result.strategy, PERIODIC_SYNC_STRATEGIES.NATIVE);
    assert.equal(registeredTag, 'sync-feed');
    assert.equal(registeredOptions.minInterval, 43200000);
  } finally {
    delete globalThis.ServiceWorkerRegistration;
    setMockWindow(origWindow);
    setMockNavigator(origNav);
  }
});

test('periodic sync: PeriodicSyncPlugin dispatches registered tag handlers in SW', async () => {
  let feedSynced = false;
  let customSynced = false;

  const plugin = new PeriodicSyncPlugin({
    tags: {
      'sync-feed': async (event) => {
        feedSynced = true;
      },
    },
    onSync: async (event) => {
      customSynced = true;
    },
  });

  // 1. Registered tag
  let waitP1 = null;
  const event1 = {
    tag: 'sync-feed',
    waitUntil: (p) => { waitP1 = p; },
  };
  plugin.onPeriodicSync(event1);
  await waitP1;
  assert.equal(feedSynced, true);

  // 2. Custom unhandled tag falls back to onSync
  let waitP2 = null;
  const event2 = {
    tag: 'other-task',
    waitUntil: (p) => { waitP2 = p; },
  };
  plugin.onPeriodicSync(event2);
  await waitP2;
  assert.equal(customSynced, true);
});

test('periodic sync: SW handleSync dispatches to configured plugins', async () => {
  let pluginCalled = false;

  const testPlugin = {
    onPeriodicSync: async (event) => {
      if (event.tag === 'custom-bg-task') {
        pluginCalled = true;
      }
    },
  };

  initConfig({
    plugins: [testPlugin],
  });

  let waitP = null;
  const fakeEvent = {
    tag: 'custom-bg-task',
    waitUntil: (p) => { waitP = p; },
  };

  handleSync(fakeEvent);
  await waitP;

  assert.equal(pluginCalled, true);
});

test('periodic sync: BackgroundSyncPlugin replays on periodicDrain tag', async () => {
  let replayCalled = false;

  const syncPlugin = new BackgroundSyncPlugin({
    queueName: 'orders',
    periodicDrain: true,
  });

  syncPlugin.replay = async () => {
    replayCalled = true;
  };

  let waitP = null;
  const fakeEvent = {
    tag: 'nlpwa-sync:orders:periodic',
    waitUntil: (p) => { waitP = p; },
  };

  syncPlugin.onPeriodicSync(fakeEvent);
  await waitP;

  assert.equal(replayCalled, true);
});
