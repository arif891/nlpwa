import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDevMode, enforceDevMode, isDevFlag } from '../src/client/dev-mode.js';
import { register, unregister } from '../src/client/registration.js';
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


  test('isDevMode: detects window.NLPWA_DEV = true (boolean, string)', async () => {
    globalThis.window.NLPWA_DEV = true;
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_DEV = 'true';
    assert.strictEqual(await isDevMode(), true);

    globalThis.window.NLPWA_DEV = false;
    assert.strictEqual(await isDevMode(), false);
  });

  test('isDevFlag: evaluates dev truthy vs falsy values', () => {
    assert.strictEqual(isDevFlag(true), true);
    assert.strictEqual(isDevFlag('true'), true);
    assert.strictEqual(isDevFlag(''), true);

    assert.strictEqual(isDevFlag(1), false);
    assert.strictEqual(isDevFlag('1'), false);
    assert.strictEqual(isDevFlag(false), false);
    assert.strictEqual(isDevFlag('false'), false);
    assert.strictEqual(isDevFlag(0), false);
    assert.strictEqual(isDevFlag('0'), false);
    assert.strictEqual(isDevFlag(null), false);
    assert.strictEqual(isDevFlag(undefined), false);
    assert.strictEqual(isDevFlag('no'), false);
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

    const scriptWithDev1 = {
      getAttribute: (name) => (name === 'data-dev' ? '1' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    assert.strictEqual(await isDevMode(scriptWithDev1), false);

    const scriptWithDevFalse = {
      getAttribute: (name) => (name === 'data-dev' ? 'false' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    assert.strictEqual(await isDevMode(scriptWithDevFalse), false);

    const scriptWithDevZero = {
      getAttribute: (name) => (name === 'data-dev' ? '0' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    assert.strictEqual(await isDevMode(scriptWithDevZero), false);

    const scriptWithoutDev = {
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    assert.strictEqual(await isDevMode(scriptWithoutDev), false);
  });

  test('isDevMode: never calls fetch and operates purely locally', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ dev: true }) };
    };

    assert.strictEqual(await isDevMode(), false);
    assert.strictEqual(fetchCalled, false);
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

    const res = await enforceDevMode({ reload: false });
    assert.strictEqual(res, true);
    assert.strictEqual(unregisterCalled, 2);
    assert.strictEqual(cacheDeleted, 2);
    assert.strictEqual(globalThis.window.NLPWA_DEV_ACTIVE, true);
  });

  test('enforceDevMode: reloads once if active Service Worker controller was present', async () => {
    let reloaded = 0;
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    globalThis.window.location = {
      reload: () => { reloaded++; },
    };

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        controller: { scriptURL: '/sw.js' },
        getRegistrations: async () => [{ unregister: async () => true }],
      },
      configurable: true,
      writable: true,
    });

    globalThis.caches = {
      keys: async () => [],
      delete: async () => true,
    };

    // First call: reloads once and sets sessionStorage guard
    await enforceDevMode({ reload: true });
    assert.strictEqual(reloaded, 1);
    assert.strictEqual(store.get('nlpwa_dev_reloaded'), '1');

    // Second call: guard prevents loop
    await enforceDevMode({ reload: true });
    assert.strictEqual(reloaded, 1);
  });

  test('enforceDevMode: reloads even if sessionStorage throws (e.g. sandboxed iframe or blocked)', async () => {
    let reloaded = 0;
    globalThis.sessionStorage = {
      getItem: () => { throw new Error('Access denied'); },
      setItem: () => { throw new Error('Access denied'); },
    };
    globalThis.window.location = {
      reload: () => { reloaded++; },
    };

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        controller: { scriptURL: '/sw.js' },
        getRegistrations: async () => [{ unregister: async () => true }],
      },
      configurable: true,
      writable: true,
    });

    globalThis.caches = {
      keys: async () => [],
      delete: async () => true,
    };

    await enforceDevMode({ reload: true });
    assert.strictEqual(reloaded, 1);
  });

  test('enforceDevMode: warns when dev mode is active on non-localhost domain', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      globalThis.window.location = { hostname: 'app.example.com' };
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: {
          getRegistrations: async () => [],
        },
        configurable: true,
        writable: true,
      });
      globalThis.caches = {
        keys: async () => [],
        delete: async () => true,
      };

      await enforceDevMode({ reload: false });
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('app.example.com'));

      // Should not warn on localhost
      warnings.length = 0;
      globalThis.window.location = { hostname: 'localhost' };
      await enforceDevMode({ reload: false });
      assert.strictEqual(warnings.length, 0);

      // Should not warn on 127.0.0.1
      globalThis.window.location = { hostname: '127.0.0.1' };
      await enforceDevMode({ reload: false });
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('unregister: does not delete caches by default unless purgeCaches is true', async () => {
    let unregisterCalled = 0;
    let cacheDeleted = 0;

    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        getRegistration: async () => ({ unregister: async () => { unregisterCalled++; return true; } }),
      },
      configurable: true,
      writable: true,
    });

    globalThis.caches = {
      keys: async () => ['precache-v1'],
      delete: async () => { cacheDeleted++; return true; },
    };

    // 1. Default unregister (e.g. on logout)
    await unregister('/');
    assert.strictEqual(unregisterCalled, 1);
    assert.strictEqual(cacheDeleted, 0);

    // 2. Unregister with purgeCaches: true
    await unregister('/', { purgeCaches: true });
    assert.strictEqual(unregisterCalled, 2);
    assert.strictEqual(cacheDeleted, 1);
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

    // 1. With window.NLPWA_DEV = true
    globalThis.window.NLPWA_DEV = true;
    const handle = await register('/sw.js');
    assert.strictEqual(handle, null);
    assert.strictEqual(swRegistered, false);

    // 2. With script data-dev attribute
    delete globalThis.window.NLPWA_DEV;
    const devScript = {
      getAttribute: (name) => (name === 'data-dev' ? 'true' : null),
      hasAttribute: (name) => name === 'data-dev',
    };
    const handle2 = await register('/sw.js', { script: devScript });
    assert.strictEqual(handle2, null);
    assert.strictEqual(swRegistered, false);
  });

  test('SW router: routes no-store config request to network-only', () => {
    const swConfig = initConfig({
      version: '1.0.0',
      routes: [
        { match: '/api/**', strategy: 'cache-first' },
      ],
      updateAPI: { version: '/v', info: '/i' },
    });

    const devCheckReq = new Request('http://localhost:3000/api/update/config.json', { cache: 'no-store' });
    const devCheckHandler = resolveStrategy(devCheckReq, swConfig.routes);
    assert.strictEqual(devCheckHandler.strategy, 'network-only');
  });
});
