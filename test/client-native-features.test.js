import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock window / navigator before imports
class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(cb);
  }
  removeEventListener(type, cb) {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(event) {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const cb of set) cb(event);
    }
    return true;
  }
}

globalThis.window = new MockEventTarget();
globalThis.window.matchMedia = (query) => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

Object.defineProperty(globalThis, 'navigator', {
  value: {
    onLine: true,
    storage: {
      persisted: async () => false,
      persist: async () => true,
    },
    serviceWorker: new MockEventTarget(),
  },
  configurable: true,
});

const {
  isInstalled,
  isInstallable,
  onInstallable,
  onAppInstalled,
  promptInstall,
} = await import('../src/client/install.js');

const {
  isStoragePersistent,
  requestPersistentStorage,
} = await import('../src/client/storage.js');

const {
  getState,
  subscribe,
  nlpwa,
  client,
} = await import('../src/client/status-store.js');

test('install: isInstalled detects non-installed state by default', () => {
  assert.equal(isInstalled(), false);
  assert.equal(isInstallable(), false);
});

test('install: onInstallable fires and promptInstall executes deferred prompt', async () => {
  let installableInfo = null;
  const unsub = onInstallable((info) => {
    installableInfo = info;
  });

  assert.equal(installableInfo.isInstallable, false);

  // Simulate beforeinstallprompt event
  let promptCalled = false;
  const fakePromptEvent = {
    type: 'beforeinstallprompt',
    preventDefault: () => {},
    prompt: async () => { promptCalled = true; },
    userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
  };

  globalThis.window.dispatchEvent(fakePromptEvent);

  assert.equal(isInstallable(), true);
  assert.equal(installableInfo.isInstallable, true);

  // Trigger promptInstall
  const result = await promptInstall();
  assert.equal(promptCalled, true);
  assert.equal(result.outcome, 'accepted');
  assert.equal(isInstallable(), false);
  assert.equal(isInstalled(), true);

  unsub();
});

test('install: onAppInstalled listener fires when appinstalled event is dispatched', () => {
  let appInstalledFired = false;
  const unsub = onAppInstalled(() => {
    appInstalledFired = true;
  });

  globalThis.window.dispatchEvent({ type: 'appinstalled' });
  assert.equal(appInstalledFired, true);
  assert.equal(isInstalled(), true);

  unsub();
});

test('storage: isStoragePersistent and requestPersistentStorage interact with navigator.storage', async () => {
  const persisted = await isStoragePersistent();
  assert.equal(persisted, false);

  const granted = await requestPersistentStorage();
  assert.equal(granted, true);
});

test('status-store: getState returns current snapshot and updates on online/offline events', () => {
  const initial = getState();
  assert.equal(typeof initial, 'object');
  assert.equal(initial.online, true);

  let notifiedState = null;
  const unsub = subscribe((state) => {
    notifiedState = state;
  });

  assert.equal(notifiedState.online, true);

  // Simulate offline
  globalThis.window.dispatchEvent({ type: 'offline' });
  assert.equal(getState().online, false);
  assert.equal(notifiedState.online, false);

  // Simulate online
  globalThis.window.dispatchEvent({ type: 'online' });
  assert.equal(getState().online, true);
  assert.equal(notifiedState.online, true);

  unsub();
});

test('status-store: nlpwa and client expose unified API', () => {
  assert.equal(nlpwa, client);
  assert.equal(typeof nlpwa.register, 'function');
  assert.equal(typeof nlpwa.unregister, 'function');
  assert.equal(typeof nlpwa.getState, 'function');
  assert.equal(typeof nlpwa.subscribe, 'function');
  assert.equal(typeof nlpwa.subscribeChannel, 'function');
  assert.equal(typeof nlpwa.getChannel, 'function');
  assert.equal(typeof nlpwa.isInstallable, 'function');
  assert.equal(typeof nlpwa.isInstalled, 'function');
  assert.equal(typeof nlpwa.promptInstall, 'function');
  assert.equal(typeof nlpwa.onInstallable, 'function');
  assert.equal(typeof nlpwa.onAppInstalled, 'function');
  assert.equal(typeof nlpwa.requestUpdateCheck, 'function');
  assert.equal(typeof nlpwa.applyUpdate, 'function');
  assert.equal(typeof nlpwa.onUpdateReady, 'function');
  assert.equal(typeof nlpwa.onNoUpdate, 'function');
  assert.equal(typeof nlpwa.onUpdateRequired, 'function');
  assert.equal(typeof nlpwa.onUpdateFailed, 'function');
  assert.equal(typeof nlpwa.onUpdateApplied, 'function');
  assert.equal(typeof nlpwa.onStagingProgress, 'function');
  assert.equal(typeof nlpwa.getStatus, 'function');
  assert.equal(typeof nlpwa.getVersion, 'function');
  assert.equal(typeof nlpwa.getCacheInfo, 'function');
  assert.equal(typeof nlpwa.cleanupRuntimeCache, 'function');
  assert.equal(typeof nlpwa.isStoragePersistent, 'function');
  assert.equal(typeof nlpwa.requestPersistentStorage, 'function');
  assert.equal(typeof nlpwa.setAppBadge, 'function');
  assert.equal(typeof nlpwa.clearAppBadge, 'function');
  assert.equal(typeof nlpwa.isBadgingSupported, 'function');
  assert.equal(typeof nlpwa.getDiagnostics, 'function');
  assert.equal(typeof nlpwa.getPinStatus, 'function');
  assert.equal(typeof nlpwa.markHealthy, 'function');
  assert.equal(typeof nlpwa.reportBootFailure, 'function');
  assert.equal(typeof nlpwa.rollback, 'function');
  assert.equal(typeof nlpwa.watchdog, 'function');
});
