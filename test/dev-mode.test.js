import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDevMode, enforceDevMode } from '../src/client/dev-mode.js';
import { register } from '../src/client/registration.js';
import { initConfig } from '../src/sw/config/index.js';
import { resolveStrategy } from '../src/sw/fetch/router.js';

describe('Dev Mode & UI Design Support', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalSW = globalThis.navigator?.serviceWorker;

  beforeEach(() => {
    globalThis.window = {
      location: { origin: 'http://localhost:3000' },
    };
    globalThis.document = {
      currentScript: null,
      querySelectorAll: () => [],
    };
    try {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: {
          getRegistration: async () => null,
          getRegistrations: async () => [],
          register: async () => ({ scope: '/' }),
        },
        configurable: true,
        writable: true,
      });
    } catch {
      // If navigator can't be mutated directly
    }

    globalThis.caches = {
      keys: async () => [],
      delete: async () => true,
    };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    if (originalSW !== undefined) {
      try {
        Object.defineProperty(globalThis.navigator, 'serviceWorker', {
          value: originalSW,
          configurable: true,
          writable: true,
        });
      } catch {}
    }
  });

  test('isDevMode: detects options.dev = true', async () => {
    const result = await isDevMode(null, { dev: true });
    assert.strictEqual(result, true);
  });

  test('isDevMode: detects window.NLPWA_DEV = true (boolean, string, number)', async () => {
    globalThis.window.NLPWA_DEV = true;
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_DEV = 'true';
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_DEV = 1;
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_DEV = false;
    assert.strictEqual(await isDevMode(), false);
  });

  test('isDevMode: detects data-dev attribute on client script tag', async () => {
    const scriptWithDevTrue = {
      getAttribute: (name) => (name === 'data-dev' ? 'true' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    assert.strictEqual(await isDevMode(scriptWithDevTrue), true);

    const scriptWithBooleanDev = {
      getAttribute: (name) => (name === 'data-dev' ? '' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    assert.strictEqual(await isDevMode(scriptWithBooleanDev), true);

    const scriptWithoutDev = {
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    assert.strictEqual(await isDevMode(scriptWithoutDev), false);
  });

  test('isDevMode: detects window.NLPWA_CONFIG.dev = true', async () => {
    globalThis.window.NLPWA_CONFIG = { dev: true };
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_CONFIG = { dev: false };
    assert.strictEqual(await isDevMode(), false);
  });

  test('isDevMode: detects dev: true from runtime config.json fetch', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/update/config.json')) {
        return {
          ok: true,
          json: async () => ({ version: '1.0.0', dev: true }),
        };
      }
      return { ok: false };
    };

    const isDev = await isDevMode();
    assert.strictEqual(isDev, true);
  });

  test('enforceDevMode: unregisters active service worker registrations and purges caches', async () => {
    let unregisterCalled = 0;
    let cacheDeleted = 0;

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        getRegistrations: async () => [
          { unregister: async () => { unregisterCalled++; return true; } },
          { unregister: async () => { unregisterCalled++; return true; } },
        ],
      },
      configurable: true,
      writable: true,
    });

    globalThis.caches = {
      keys: async () => ['precache-v1', 'runtime-cache'],
      delete: async () => { cacheDeleted++; return true; },
    };

    const res = await enforceDevMode();
    assert.strictEqual(res, true);
    assert.strictEqual(unregisterCalled, 2);
    assert.strictEqual(cacheDeleted, 2);
    assert.strictEqual(globalThis.window.NLPWA_DEV_ACTIVE, true);
  });

  test('register: bypasses SW registration and returns null when dev is active', async () => {
    let swRegistered = false;
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        register: async () => {
          swRegistered = true;
          return { scope: '/' };
        },
        getRegistrations: async () => [],
      },
      configurable: true,
      writable: true,
    });

    // 1. With options.dev = true
    const handle1 = await register('/sw.js', { dev: true });
    assert.strictEqual(handle1, null);
    assert.strictEqual(swRegistered, false);

    // 2. With window.NLPWA_DEV = true
    globalThis.window.NLPWA_DEV = true;
    const handle2 = await register('/sw.js');
    assert.strictEqual(handle2, null);
    assert.strictEqual(swRegistered, false);
  });

  test('SW router: routes dev-check config query to network-only', () => {
    const swConfig = initConfig({
      version: '1.0.0',
      routes: [
        { match: '/api/**', strategy: 'cache-first' },
      ],
      updateAPI: { version: '/v', info: '/i' },
    });

    const devCheckReq = new Request('http://localhost:3000/api/update/config.json?nlpwa_dev=1');
    const devCheckHandler = resolveStrategy(devCheckReq, swConfig.routes);
    assert.strictEqual(devCheckHandler.strategy, 'network-only');
  });
});
