import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isUserEditing, register, applyUpdate, unregister, getVersion, getStatus, onStagingProgress } from '../src/client/register.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';


test('isUserEditing: correctly identifies when user has focused input/editing fields', () => {
  // 1. undefined document
  const origDoc = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(isUserEditing(), false);

    // 2. document without activeElement
    globalThis.document = { activeElement: null };
    assert.equal(isUserEditing(), false);

    // 3. non-editing elements (div, button, submit)
    globalThis.document = { activeElement: { tagName: 'DIV' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'BUTTON' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'submit' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'button' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'checkbox' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'radio' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'range' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'color' } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'file' } };
    assert.equal(isUserEditing(), false);

    // Disabled or readOnly inputs
    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'text', disabled: true } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'text', readOnly: true } };
    assert.equal(isUserEditing(), false);

    globalThis.document = { activeElement: { tagName: 'TEXTAREA', readOnly: true } };
    assert.equal(isUserEditing(), false);

    // 4. text inputs, textareas, selects, and contentEditable
    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'text' } };
    assert.equal(isUserEditing(), true);

    globalThis.document = { activeElement: { tagName: 'INPUT', type: 'email' } };
    assert.equal(isUserEditing(), true);

    globalThis.document = { activeElement: { tagName: 'TEXTAREA' } };
    assert.equal(isUserEditing(), true);

    globalThis.document = { activeElement: { tagName: 'SELECT' } };
    assert.equal(isUserEditing(), true);

    globalThis.document = { activeElement: { tagName: 'DIV', isContentEditable: true } };
    assert.equal(isUserEditing(), true);
  } finally {
    globalThis.document = origDoc;
  }
});

test('register: autoReload is suppressed when user is editing, offering prompt instead', async () => {
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    const swListeners = new Map();
    const docEvents = [];

    // Mock navigator.serviceWorker
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          async register() {
            return { scope: '/' };
          },
          addEventListener(event, fn) {
            if (!swListeners.has(event)) swListeners.set(event, []);
            swListeners.get(event).push(fn);
          },
          removeEventListener(event, fn) {
            const list = swListeners.get(event) || [];
            swListeners.set(event, list.filter(l => l !== fn));
          },
          controller: null,
        },
      },
      configurable: true,
      writable: true,
    });

    // User is editing in an input
    Object.defineProperty(globalThis, 'document', {
      value: {
        activeElement: {
          tagName: 'INPUT',
          type: 'text',
          addEventListener() {
            throw new Error('Should not attach blur/change listeners to auto-apply on blur!');
          },
        },
        dispatchEvent(evt) {
          docEvents.push(evt);
          return true;
        },
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
      writable: true,
    });

    let promptCalled = false;
    let promptData = null;

    const handle = await register('/sw.js', {
      autoReload: true,
      pollIntervalMs: 0,
      onUpdatePrompt: (data) => {
        promptCalled = true;
        promptData = data;
      },
    });

    // Simulate SW broadcasting UPDATE_READY
    const messageListeners = swListeners.get('message') || [];
    for (const listener of messageListeners) {
      listener({
        data: {
          type: MESSAGE_TYPES.UPDATE_READY,
          version: '2.0.0',
        },
      });
    }

    // Must have offered prompt rather than auto-applying or hooking blur
    assert.equal(promptCalled, true);
    assert.equal(promptData.version, '2.0.0');

    const promptEvt = docEvents.find(e => e.type === 'nlpwa:update-prompt');
    assert.ok(promptEvt, 'Dispatched nlpwa:update-prompt event');
    assert.equal(promptEvt.detail.version, '2.0.0');
    assert.equal(promptEvt.detail.reason, 'editing');

    handle?.unsubscribe();
  } finally {
    if (origDocDesc) {
      Object.defineProperty(globalThis, 'document', origDocDesc);
    } else {
      delete globalThis.document;
    }
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('register: shouldDeferReload predicate defers autoReload and offers prompt for in-memory unsaved state', async () => {
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    const swListeners = new Map();
    const docEvents = [];

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          async register() {
            return { scope: '/' };
          },
          addEventListener(event, fn) {
            if (!swListeners.has(event)) swListeners.set(event, []);
            swListeners.get(event).push(fn);
          },
          removeEventListener(event, fn) {
            const list = swListeners.get(event) || [];
            swListeners.set(event, list.filter(l => l !== fn));
          },
          controller: null,
        },
      },
      configurable: true,
      writable: true,
    });

    // User is NOT focusing any form element (e.g. focused on plain BODY/DIV)
    Object.defineProperty(globalThis, 'document', {
      value: {
        activeElement: { tagName: 'DIV' },
        dispatchEvent(evt) {
          docEvents.push(evt);
          return true;
        },
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
      writable: true,
    });

    let promptCalled = false;
    let promptData = null;
    let uploadInProgress = true;

    const handle = await register('/sw.js', {
      autoReload: true,
      pollIntervalMs: 0,
      shouldDeferReload: ({ version, reason }) => {
        return uploadInProgress;
      },
      onUpdatePrompt: (data) => {
        promptCalled = true;
        promptData = data;
      },
    });

    // Simulate SW broadcasting UPDATE_READY
    const messageListeners = swListeners.get('message') || [];
    for (const listener of messageListeners) {
      listener({
        data: {
          type: MESSAGE_TYPES.UPDATE_READY,
          version: '2.0.0',
        },
      });
    }

    assert.equal(promptCalled, true, 'Prompt called because shouldDeferReload returned true');
    assert.equal(promptData.version, '2.0.0');
    assert.equal(promptData.reason, 'deferred');

    const promptEvt = docEvents.find(e => e.type === 'nlpwa:update-prompt');
    assert.ok(promptEvt, 'Dispatched nlpwa:update-prompt event');
    assert.equal(promptEvt.detail.reason, 'deferred');

    handle?.unsubscribe();
  } finally {
    if (origDocDesc) {
      Object.defineProperty(globalThis, 'document', origDocDesc);
    } else {
      delete globalThis.document;
    }
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('applyUpdate: aborts reload when SW replies applied: false', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origWinDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origChan = globalThis.MessageChannel;

  try {
    let reloadCalled = false;
    globalThis.window = {
      location: {
        reload() {
          reloadCalled = true;
        },
      },
    };

    // Mock MessageChannel
    class MockPort {
      constructor() {
        this.onmessage = null;
      }
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
        // Reply with applied: false
        if (ports?.[0]) {
          ports[0].postMessage({
            type: MESSAGE_TYPES.APPLY_UPDATE_RESULT,
            requestId: msg.requestId,
            data: { applied: false },
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

    const result = await applyUpdate({ reload: true, checkTabs: false });
    assert.equal(result, false, 'applyUpdate returns false when applied is false');
    assert.equal(reloadCalled, false, 'window.location.reload must not be called when applied is false');
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (origWinDesc) {
      Object.defineProperty(globalThis, 'window', origWinDesc);
    } else {
      delete globalThis.window;
    }
    if (origChan) {
      globalThis.MessageChannel = origChan;
    } else {
      delete globalThis.MessageChannel;
    }
  }
});

test('register: shouldDeferReload priority sets reason "deferred" when user is also editing', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origDoc = globalThis.document;

  try {
    const swListeners = new Map();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async () => ({ scope: '/' }),
          controller: { postMessage() {} },
          addEventListener(event, listener) {
            if (!swListeners.has(event)) swListeners.set(event, []);
            swListeners.get(event).push(listener);
          },
          removeEventListener(event, listener) {
            const list = swListeners.get(event) || [];
            swListeners.set(event, list.filter(l => l !== listener));
          },
        },
      },
      configurable: true,
      writable: true,
    });

    // Simulate user editing text input
    globalThis.document = {
      activeElement: { tagName: 'INPUT', type: 'text' },
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    };

    let promptData = null;
    const handle = await register('/sw.js', {
      autoReload: true,
      pollIntervalMs: 0,
      checkOnRegister: false,
      shouldDeferReload: () => true, // custom defer
      onUpdatePrompt: (data) => {
        promptData = data;
      },
    });

    const listeners = swListeners.get('message') || [];
    assert.ok(listeners.length > 0);
    for (const l of listeners) {
      l({
        data: {
          type: MESSAGE_TYPES.UPDATE_READY,
          version: '1.2.0',
        },
      });
    }

    assert.ok(promptData);
    assert.equal(promptData.reason, 'deferred', 'custom defer takes precedence over editing for reason string');
    handle?.unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    globalThis.document = origDoc;
  }
});
test('register: checkOnRegister sends CHECK_UPDATE to SW without blocking', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    const sentMessages = [];
    const mockController = {
      postMessage(msg) {
        sentMessages.push(msg);
      },
    };

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: mockController,
          ready: Promise.resolve({ active: mockController }),
          async register() {
            return { scope: '/' };
          },
          addEventListener() {},
          removeEventListener() {},
        },
      },
      configurable: true,
      writable: true,
    });

    const handle = await register('/sw.js', { pollIntervalMs: 0 });
    // Allow microtasks to resolve ready promise
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, MESSAGE_TYPES.CHECK_UPDATE);

    handle?.unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('register: checkOnRegister: false suppresses initial check', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    const sentMessages = [];
    const mockController = {
      postMessage(msg) {
        sentMessages.push(msg);
      },
    };

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: mockController,
          ready: Promise.resolve({ active: mockController }),
          async register() {
            return { scope: '/' };
          },
          addEventListener() {},
          removeEventListener() {},
        },
      },
      configurable: true,
      writable: true,
    });

    const handle = await register('/sw.js', { checkOnRegister: false, pollIntervalMs: 0 });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentMessages.length, 0);

    handle?.unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('register: registers periodicSync when supported and options.periodicSync is default/true', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    const mockController = { postMessage() {} };
    let periodicSyncRegistered = null;

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: mockController,
          ready: Promise.resolve({ active: mockController }),
          async register() {
            return {
              scope: '/',
              periodicSync: {
                async register(tag, opts) {
                  periodicSyncRegistered = { tag, opts };
                },
              },
            };
          },
          addEventListener() {},
          removeEventListener() {},
        },
      },
      configurable: true,
      writable: true,
    });

    const handle = await register('/sw.js', { pollIntervalMs: 86400000, checkOnRegister: false });
    assert.ok(periodicSyncRegistered, 'periodicSync should be registered');
    assert.equal(periodicSyncRegistered.tag, 'nlpwa-update-check');
    assert.equal(periodicSyncRegistered.opts.minInterval, 86400000);
    handle?.unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('register: periodicSync: false suppresses periodicSync registration', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    const mockController = { postMessage() {} };
    let periodicSyncRegistered = null;

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: mockController,
          ready: Promise.resolve({ active: mockController }),
          async register() {
            return {
              scope: '/',
              periodicSync: {
                async register(tag, opts) {
                  periodicSyncRegistered = { tag, opts };
                },
              },
            };
          },
          addEventListener() {},
          removeEventListener() {},
        },
      },
      configurable: true,
      writable: true,
    });

    const handle = await register('/sw.js', {
      periodicSync: false,
      pollIntervalMs: 86400000,
      checkOnRegister: false,
    });
    assert.equal(periodicSyncRegistered, null, 'periodicSync should not be registered');
    handle?.unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('unregister: unregisters service worker when available', async () => {
  let unregistered = false;
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          async getRegistration() {
            return {
              async unregister() {
                unregistered = true;
                return true;
              },
            };
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const result = await unregister();
    assert.equal(result, true);
    assert.equal(unregistered, true);
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('getVersion and getStatus: query active version and status from SW via MessageChannel', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origChan = globalThis.MessageChannel;
  try {
    class MockChannel {
      constructor() {
        this.port1 = {
          onmessage: null,
          close() {},
        };
        this.port2 = {
          postMessage: (data) => {
            if (this.port1.onmessage) {
              this.port1.onmessage({ data });
            }
          },
        };
      }
    }
    globalThis.MessageChannel = MockChannel;

    const mockSW = {
      postMessage(msg, ports) {
        if (msg.type === MESSAGE_TYPES.GET_VERSION) {
          ports?.[0]?.postMessage({
            type: MESSAGE_TYPES.VERSION_INFO,
            requestId: msg.requestId,
            data: { activeVersion: '1.2.3', stagedVersion: '1.2.4', swVersion: '1' },
          });
        } else if (msg.type === MESSAGE_TYPES.GET_STATUS) {
          ports?.[0]?.postMessage({
            type: MESSAGE_TYPES.STATUS_INFO,
            requestId: msg.requestId,
            data: { status: 'staging' },
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

    const versionInfo = await getVersion();
    assert.equal(versionInfo.activeVersion, '1.2.3');
    assert.equal(versionInfo.stagedVersion, '1.2.4');

    const status = await getStatus();
    assert.equal(status, 'staging');
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (origChan) {
      globalThis.MessageChannel = origChan;
    } else {
      delete globalThis.MessageChannel;
    }
  }
});

test('onStagingProgress: receives staging progress events', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    let messageListener = null;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          addEventListener(event, listener) {
            if (event === 'message') messageListener = listener;
          },
          removeEventListener() {},
        },
      },
      configurable: true,
      writable: true,
    });

    const progressReports = [];
    const unsubscribe = onStagingProgress((progress) => {
      progressReports.push(progress);
    });

    assert.ok(messageListener);
    messageListener({
      data: {
        type: MESSAGE_TYPES.STAGING_PROGRESS,
        version: '1.1.0',
        loaded: 5,
        total: 10,
        percent: 50,
        file: '/app.js',
      },
    });

    assert.equal(progressReports.length, 1);
    assert.equal(progressReports[0].percent, 50);
    assert.equal(progressReports[0].file, '/app.js');

    unsubscribe();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('register: auto-registration (_auto: true) does not unsubscribe or overwrite manual registration', async () => {
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  try {
    const swListeners = new Map();
    let registerCount = 0;

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          async register(url) {
            registerCount++;
            return { scope: '/' };
          },
          addEventListener(event, fn) {
            if (!swListeners.has(event)) swListeners.set(event, []);
            swListeners.get(event).push(fn);
          },
          removeEventListener(event, fn) {
            const list = swListeners.get(event) || [];
            swListeners.set(event, list.filter(l => l !== fn));
          },
          controller: null,
        },
      },
      configurable: true,
      writable: true,
    });

    let manualCallbackFired = false;
    // Step 1: User calls register() manually (e.g. in inline script before DOMContentLoaded)
    await register('/sw.js', {
      onUpdateReady: () => {
        manualCallbackFired = true;
      },
    });
    assert.equal(registerCount, 1);

    // Step 2: Deferred auto-register executes with _auto: true (e.g. upon DOMContentLoaded)
    const autoResult = await register('/sw.js', { _auto: true });
    assert.equal(autoResult, null, 'auto-register should return null and no-op');
    assert.equal(registerCount, 1, 'auto-register should not re-register with SW');

    // Step 3: Trigger UPDATE_READY and ensure manual callback is still intact!
    const msgListeners = swListeners.get('message') || [];
    for (const fn of msgListeners) {
      fn({ data: { type: MESSAGE_TYPES.UPDATE_READY, version: '1.2.0' } });
    }
    assert.equal(manualCallbackFired, true, 'manual onUpdateReady was preserved');

    // Step 4: Clean up
    await unregister();
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (origDocDesc) {
      Object.defineProperty(globalThis, 'document', origDocDesc);
    } else {
      delete globalThis.document;
    }
  }
});

test('client standalone: auto-registers with derived subpath base from script src and does not match vendor-client.js', async () => {
  const clientBundle = readFileSync(fileURLToPath(new URL('../out/client.js', import.meta.url)), 'utf8');

  const registeredUrls = [];
  const fakeNavigator = {
    serviceWorker: {
      async register(url, options) {
        registeredUrls.push({ url, options });
        return { scope: url.replace(/sw\.js$/, '') };
      },
      addEventListener() {},
      removeEventListener() {},
      controller: null,
    },
  };

  const fakeDocument = {
    readyState: 'complete',
    currentScript: null, // Simulate deferred path where currentScript is null
    querySelectorAll(selector) {
      if (selector === 'script[src]') {
        return [
          { getAttribute: (attr) => attr === 'src' ? '/vendor/vendor-client.js' : null },
          { getAttribute: (attr) => attr === 'src' ? '/my-subpath/client.js' : null, src: 'http://localhost/my-subpath/client.js' },
        ];
      }
      return [];
    },
  };

  const fakeWindow = {
    location: { href: 'http://localhost/my-subpath/', origin: 'http://localhost' },
    addEventListener() {},
    removeEventListener() {},
    document: fakeDocument,
    navigator: fakeNavigator,
  };

  const { createContext, runInContext } = await import('node:vm');
  const context = createContext({
    window: fakeWindow,
    document: fakeDocument,
    navigator: fakeNavigator,
    self: fakeWindow,
    URL,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console,
  });


  runInContext(clientBundle, context);

  await new Promise(r => setTimeout(r, 50));

  assert.equal(registeredUrls.length, 1);
  assert.equal(registeredUrls[0].url, '/my-subpath/sw.js', 'derived subpath /my-subpath/sw.js correctly');
});



