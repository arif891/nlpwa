import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import {
  markHealthy,
  reportBootFailure,
  rollback,
  getBlockedVersions,
  onRollbackApplied,
  watchdog,
} from '../src/client/watchdog.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

function setNavigator(val) {
  Object.defineProperty(globalThis, 'navigator', {
    value: val,
    configurable: true,
    writable: true,
  });
}

test('client watchdog: markHealthy dispatches event and sends REPORT_BOOT_HEALTH to SW', async () => {
  const sent = [];
  const events = [];

  setNavigator({
    serviceWorker: {
      ready: Promise.resolve({
        active: { postMessage: (m) => sent.push(m) },
      }),
      controller: { postMessage: (m) => sent.push(m) },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  globalThis.document = {
    dispatchEvent(e) {
      events.push(e);
    },
  };

  await markHealthy('2.0.0');

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'nlpwa:boot-healthy');
  assert.equal(events[0].detail.version, '2.0.0');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, MESSAGE_TYPES.REPORT_BOOT_HEALTH);
  assert.equal(sent[0].version, '2.0.0');
});

test('client watchdog: reportBootFailure dispatches event and sends REPORT_BOOT_FAILURE to SW', async () => {
  const sent = [];
  const events = [];

  setNavigator({
    serviceWorker: {
      ready: Promise.resolve({
        active: { postMessage: (m) => sent.push(m) },
      }),
      controller: { postMessage: (m) => sent.push(m) },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  globalThis.document = {
    dispatchEvent(e) {
      events.push(e);
    },
  };

  await reportBootFailure(new Error('Fatal syntax error'), { version: '2.0.0', rollback: true });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'nlpwa:boot-failure');
  assert.equal(events[0].detail.error, 'Fatal syntax error');
  assert.equal(events[0].detail.rollback, true);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, MESSAGE_TYPES.REPORT_BOOT_FAILURE);
  assert.equal(sent[0].error, 'Fatal syntax error');
  assert.equal(sent[0].rollback, true);
});

test('client watchdog: watchdog times out and triggers failure when markHealthy is not called', async () => {
  const sent = [];
  const windowListeners = new Map();

  globalThis.window = {
    addEventListener(name, fn) {
      windowListeners.set(name, fn);
    },
    removeEventListener(name) {
      windowListeners.delete(name);
    },
  };

  setNavigator({
    serviceWorker: {
      ready: Promise.resolve({
        active: { postMessage: (m) => sent.push(m) },
      }),
      controller: { postMessage: (m) => sent.push(m) },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  globalThis.document = {
    dispatchEvent() {},
  };

  const cancel = watchdog({ timeoutMs: 50, onCrash: 'rollback', autoReload: false });

  // Wait for watchdog timeout to trigger
  await new Promise((r) => setTimeout(r, 80));

  assert.ok(sent.some((m) => m.type === MESSAGE_TYPES.REPORT_BOOT_FAILURE), 'sent boot failure after timeout');
  cancel();
});

test('client watchdog: isFirstPartyError filters out browser extensions and cross-origin noise', async () => {
  const { isFirstPartyError } = await import('../src/client/watchdog.js');

  // Same-origin first-party error
  globalThis.window = { location: { origin: 'https://example.com', href: 'https://example.com/' } };
  assert.equal(isFirstPartyError({ filename: 'https://example.com/app.js', message: 'SyntaxError' }), true);
  assert.equal(isFirstPartyError(new Error('Internal logic failure')), true);

  // Chrome extension
  assert.equal(isFirstPartyError({ filename: 'chrome-extension://xyz/content.js', message: 'Extension error' }), false);
  assert.equal(isFirstPartyError(new Error('Extension crashed\n    at chrome-extension://abc/inject.js:10:5')), false);

  // Firefox & Safari extensions
  assert.equal(isFirstPartyError({ filename: 'moz-extension://xyz/content.js' }), false);
  assert.equal(isFirstPartyError({ filename: 'safari-web-extension://xyz/content.js' }), false);

  // Cross-origin 3rd-party script (e.g. GTM, ads, trackers)
  assert.equal(isFirstPartyError({ filename: 'https://googletagmanager.com/gtm.js', message: 'Network err' }), false);
  assert.equal(isFirstPartyError({ filename: 'https://cdn.thirdparty.com/lib.js' }), false);

  // Opaque cross-origin Script error.
  assert.equal(isFirstPartyError({ message: 'Script error.' }), false);
});
