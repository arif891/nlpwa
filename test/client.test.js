import test from 'node:test';
import assert from 'node:assert/strict';
import { isUserEditing, register } from '../src/client/register.js';
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
