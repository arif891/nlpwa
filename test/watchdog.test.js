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
