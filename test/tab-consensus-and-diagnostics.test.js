import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { commitStaged, rollbackToFallback } from '../src/sw/update/commit.js';
import {
  pinClient,
  unpinClient,
  getClientPinStatus,
  PIN_STATES,
  resetStoreMemo,
  getActive,
} from '../src/sw/cache/store.js';
import { handleMessage } from '../src/sw/events/message.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';
import {
  registerDirtyGuard,
  setDirty,
  isTabDirty,
  checkDirtyTabs,
  isLeader,
  onLeaderChange,
  closeTabBus,
} from '../src/client/tabs.js';
import { getDiagnostics, getPinStatus } from '../src/client/diagnostics.js';
import { applyUpdate } from '../src/client/update-ui.js';

test('client pin state machine: BOOTING, PINNED, ORPHANED, EXPIRED transitions', async () => {
  setupEnv(() => new Response(''));
  resetStoreMemo();

  // 1. Unknown / booting client
  const bootStatus = getClientPinStatus('client-tab-1', { activeCache: 'offline@1.0.0' });
  assert.equal(bootStatus.state, PIN_STATES.EXPIRED);

  const nullStatus = getClientPinStatus(null, { activeCache: 'offline@1.0.0' });
  assert.equal(nullStatus.state, PIN_STATES.BOOTING);

  // 2. Pinned to current active cache
  await pinClient('client-tab-1', 'offline@1.0.0', '1.0.0', Date.now());
  const pinnedStatus = getClientPinStatus('client-tab-1', { activeCache: 'offline@1.0.0' });
  assert.equal(pinnedStatus.state, PIN_STATES.PINNED);
  assert.equal(pinnedStatus.version, '1.0.0');
  assert.equal(pinnedStatus.cache, 'offline@1.0.0');

  // 3. Active upgraded to 2.0.0, tab is now ORPHANED with grace period
  const orphanedStatus = getClientPinStatus('client-tab-1', {
    activeCache: 'offline@2.0.0',
    graceMs: 30000,
  });
  assert.equal(orphanedStatus.state, PIN_STATES.ORPHANED);
  assert.ok(orphanedStatus.graceRemainingMs > 0);

  // 4. Grace period expired
  const expiredStatus = getClientPinStatus('client-tab-1', {
    activeCache: 'offline@2.0.0',
    graceMs: -1000,
  });
  assert.equal(expiredStatus.state, PIN_STATES.EXPIRED);

  // 5. Unpinned client
  await unpinClient('client-tab-1');
  const postUnpinStatus = getClientPinStatus('client-tab-1', { activeCache: 'offline@1.0.0' });
  assert.equal(postUnpinStatus.state, PIN_STATES.EXPIRED);
});

test('SW message GET_PIN_STATUS and GET_DIAGNOSTICS', async () => {
  const v1Files = {
    '/api/update/config.json': JSON.stringify({
      version: '1.0.0',
      updateAPI: { version: '/api/update/version.json', info: '/api/update/info.json' },
      routes: [{ match: '**', strategy: 'network-first' }],
      precache: ['/app.js'],
    }),
    '/app.js': 'app code',
  };

  const server = makeServer('1.0.0', v1Files);
  setupEnv(server.fetch);
  resetStoreMemo();

  await precacheFiles();
  await commitStaged();

  const active = await getActive();
  await pinClient('client-test-id', active.cache, active.version);

  const onMsg = handleMessage({ version: '1.0.0', caches: { offline: 'offline', runtime: 'runtime', meta: 'nlpwa-meta' } });

  // Test GET_PIN_STATUS
  let pinReply = null;
  const pinEvent = {
    source: { id: 'client-test-id' },
    data: { type: MESSAGE_TYPES.GET_PIN_STATUS, requestId: 'r1' },
    ports: [{
      postMessage: (payload) => {
        pinReply = payload;
      },
    }],
    waitUntil: (p) => p,
  };

  onMsg(pinEvent);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(pinReply, 'Should receive pin reply');
  assert.equal(pinReply.type, MESSAGE_TYPES.PIN_STATUS_INFO);
  assert.equal(pinReply.data.state, PIN_STATES.PINNED);
  assert.equal(pinReply.data.version, '1.0.0');

  // Test GET_DIAGNOSTICS
  let diagReply = null;
  const diagEvent = {
    source: { id: 'client-test-id' },
    data: { type: MESSAGE_TYPES.GET_DIAGNOSTICS, requestId: 'r2' },
    ports: [{
      postMessage: (payload) => {
        diagReply = payload;
      },
    }],
    waitUntil: (p) => p,
  };

  onMsg(diagEvent);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(diagReply, 'Should receive diagnostics reply');
  assert.equal(diagReply.type, MESSAGE_TYPES.DIAGNOSTICS_INFO);
  assert.equal(diagReply.data.active.version, '1.0.0');
  assert.equal(diagReply.data.pinStatus.state, PIN_STATES.PINNED);
  assert.ok(Array.isArray(diagReply.data.blockedVersions));
  assert.ok(Array.isArray(diagReply.data.rollbackHistory));
});

test('tab consensus bus: registers dirty guards and detects unsaved state', async () => {
  closeTabBus();
  globalThis.window = { location: {} };

  // Mock BroadcastChannel in Node environment
  class MockBroadcastChannel {
    static channels = new Map();
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      if (!MockBroadcastChannel.channels.has(name)) {
        MockBroadcastChannel.channels.set(name, new Set());
      }
      MockBroadcastChannel.channels.get(name).add(this);
    }
    addEventListener(type, fn) {
      if (type === 'message') this.listeners.add(fn);
    }
    removeEventListener(type, fn) {
      if (type === 'message') this.listeners.delete(fn);
    }
    postMessage(data) {
      const set = MockBroadcastChannel.channels.get(this.name) || new Set();
      for (const ch of set) {
        if (ch !== this) {
          for (const fn of ch.listeners) {
            fn({ data });
          }
        }
      }
    }
    close() {
      const set = MockBroadcastChannel.channels.get(this.name);
      if (set) set.delete(this);
    }
  }

  globalThis.BroadcastChannel = MockBroadcastChannel;

  assert.equal(isTabDirty(), false);

  // Set manual dirty flag
  setDirty(true);
  assert.equal(isTabDirty(), true);
  setDirty(false);
  assert.equal(isTabDirty(), false);

  // Register custom dirty guard
  let formDirty = true;
  const unregister = registerDirtyGuard(() => formDirty);
  assert.equal(isTabDirty(), true);

  formDirty = false;
  assert.equal(isTabDirty(), false);

  unregister();
  assert.equal(isTabDirty(), false);

  // Test multi-tab consensus check with a simulated second tab
  const tab2 = new MockBroadcastChannel('nlpwa-tab-bus');
  tab2.addEventListener('message', (event) => {
    if (event.data?.type === 'TAB_QUERY_DIRTY') {
      tab2.postMessage({
        type: 'TAB_DIRTY_STATUS',
        queryId: event.data.queryId,
        tabId: 'simulated-tab-2',
        isDirty: true,
        title: 'Checkout Form',
      });
    }
  });

  const check = await checkDirtyTabs(50);
  assert.equal(check.hasDirtyTabs, true);
  assert.ok(check.dirtyTabs.some((t) => t.tabId === 'simulated-tab-2'));

  tab2.close();
  closeTabBus();
  delete globalThis.window;
});

test('applyUpdate: blocks reload when tabs are dirty unless forced', async () => {
  closeTabBus();

  let reloadCalled = false;
  globalThis.window = {
    location: {
      reload: () => {
        reloadCalled = true;
      },
    },
  };

  // Mock dirty tab
  setDirty(true);

  // Attempt applyUpdate with details: true
  const resBlocked = await applyUpdate({ reload: true, force: false, checkTabs: true, details: true });
  assert.equal(resBlocked.applied, false);
  assert.equal(resBlocked.blockedByDirty, true);
  assert.equal(reloadCalled, false, 'Should not reload when blocked by dirty tab');

  // Attempt applyUpdate with force: true
  // Mock SW response for APPLY_UPDATE
  class MockPort {
    constructor() { this.onmessage = null; }
    postMessage(msg) {
      if (this._partner?.onmessage) {
        this._partner.onmessage({ data: msg });
      }
    }
    close() {}
  }
  class MockChannel {
    constructor() {
      this.port1 = new MockPort();
      this.port2 = new MockPort();
      this.port1._partner = this.port2;
      this.port2._partner = this.port1;
    }
  }
  globalThis.MessageChannel = MockChannel;

  const mockSW = {
    postMessage(msg, ports) {
      if (ports?.[0]) {
        ports[0].postMessage({
          type: MESSAGE_TYPES.APPLY_UPDATE_RESULT,
          requestId: msg.requestId,
          data: { applied: true },
        });
      }
    },
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serviceWorker: {
        controller: mockSW,
        ready: Promise.resolve({ active: mockSW }),
      },
    },
    configurable: true,
    writable: true,
  });

  const resForced = await applyUpdate({ reload: true, force: true, details: true });
  assert.equal(resForced.applied, true);
  assert.equal(reloadCalled, true, 'Should reload when forced');

  setDirty(false);
  closeTabBus();
  delete globalThis.window;
});
