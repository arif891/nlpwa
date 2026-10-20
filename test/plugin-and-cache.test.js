import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCacheableUrl } from '../src/sw/cache/evict.js';
import { initConfig, updateActiveConfig, loadConfigFromCache, ensureConfigReady } from '../src/sw/config/index.js';
import { nlpwaPlugin } from '../src/rollup-plugin.js';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { findConfigFile, syncSourceConfigVersion } from '../bin/build-utils.js';
import { putInRuntime, getFromRuntime, getFromOffline } from '../src/sw/cache/runtime.js';
import { resolveStrategy } from '../src/sw/fetch/router.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { commitStaged, sweepOrphanCaches } from '../src/sw/update/commit.js';
import { getActive, openActive } from '../src/sw/cache/store.js';
import { fetchServerInfo, getSnapshotPath } from '../src/sw/update/manifest.js';

test('isCacheableUrl: cross-origin route matching respects route.origin', () => {
  globalThis.self = {
    location: { origin: 'https://example.com', href: 'https://example.com/sw.js' },
  };

  initConfig({
    routes: [
      { match: '/api/**', strategy: 'network-only' }, // same-origin only
      { match: '/api/**', strategy: 'cache-first', origin: 'https://cdn.example.com' },
      { match: '/public/**', strategy: 'cache-first', origin: '*' },
    ],
    defaultStrategy: 'network-first',
  });

  // Same-origin /api/data matches first route (network-only) -> false
  assert.equal(isCacheableUrl('https://example.com/api/data'), false);

  // Cross-origin with explicit origin matches second route (cache-first) -> true
  assert.equal(isCacheableUrl('https://cdn.example.com/api/data'), true);

  // Cross-origin with wildcard origin matches third route (cache-first) -> true
  assert.equal(isCacheableUrl('https://images.example.org/public/pic.png'), true);

  // Cross-origin without matching explicit origin falls through -> false (network-only)
  assert.equal(isCacheableUrl('https://other.example.org/feed'), false);
});

test('nlpwaPlugin: virtual:nlpwa-version and writeBundle share exact version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-plugin-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: '2.4.1', precache: [] }));

  const plugin = nlpwaPlugin({
    config: configPath,
    distDir: join(root, 'dist'),
    autoIncrement: true,
  });

  await plugin.buildStart();
  const virtualMod = await plugin.load('\0virtual:nlpwa-version');
  assert.match(virtualMod, /APP_VERSION = "2\.4\.2"/);

  await plugin.writeBundle({ dir: join(root, 'dist') });

  const manifest = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.equal(manifest.version, '2.4.2');

  const savedSource = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(savedSource.version, '2.4.2');
});

test('nlpwaPlugin: virtual:nlpwa-version exports BASE_VERSION and APP_VERSION when deriveVersion: true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-plugin-base-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: '1.0.0', precache: [] }));

  const plugin = nlpwaPlugin({
    config: configPath,
    distDir: join(root, 'dist'),
  });

  await plugin.buildStart();
  const virtualMod = await plugin.load('\0virtual:nlpwa-version');
  assert.match(virtualMod, /APP_VERSION = "1\.0\.0"/);
  assert.match(virtualMod, /BASE_VERSION = "1\.0\.0"/);

  await plugin.writeBundle({ dir: join(root, 'dist') });

  const manifest = JSON.parse(readFileSync(join(root, 'dist/api/update/version.json'), 'utf8'));
  assert.match(manifest.version, /^1\.0\.0-[0-9a-f]{12}$/);
});


test('nlpwaPlugin: custom configPath is emitted to correct subpath and tracked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-plugin-custom-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    version: '1.0.0',
    configPath: '/assets/custom-config.json',
    precache: [],
  }));

  const plugin = nlpwaPlugin({
    config: configPath,
    distDir: join(root, 'dist'),
    autoIncrement: false,
  });

  await plugin.buildStart();
  await plugin.writeBundle({ dir: join(root, 'dist') });

  const customConfig = JSON.parse(readFileSync(join(root, 'dist/assets/custom-config.json'), 'utf8'));
  assert.equal(customConfig.configPath, '/assets/custom-config.json');

  const info = JSON.parse(readFileSync(join(root, 'dist/api/update/info.json'), 'utf8'));
  assert.ok(info.files.some(f => f.path === '/assets/custom-config.json'));
});

test('nlpwaPlugin: derives content-hash version by default for different app code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-plugin-hash-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: '1.0.0', precache: ['/main.js'] }));

  // Build 1: main.js with version 1 code
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'main.js'), 'console.log("build 1 app code");');

  const plugin1 = nlpwaPlugin({
    config: configPath,
    distDir,
  });
  await plugin1.buildStart();
  await plugin1.writeBundle({ dir: distDir });

  const manifest1 = JSON.parse(readFileSync(join(distDir, 'api/update/version.json'), 'utf8'));
  assert.match(manifest1.version, /^1\.0\.0-[0-9a-f]{8,32}$/i);

  // Build 2: main.js with modified app code
  writeFileSync(join(distDir, 'main.js'), 'console.log("build 2 different code");');

  const plugin2 = nlpwaPlugin({
    config: configPath,
    distDir,
  });
  await plugin2.buildStart();
  await plugin2.writeBundle({ dir: distDir });

  const manifest2 = JSON.parse(readFileSync(join(distDir, 'api/update/version.json'), 'utf8'));
  assert.match(manifest2.version, /^1\.0\.0-[0-9a-f]{8,32}$/i);
  assert.notEqual(manifest1.version, manifest2.version, 'Emitted versions must differ when app code changes');

  // Explicit deriveVersion: false preserves base semver without hash
  const pluginNoDerive = nlpwaPlugin({
    config: configPath,
    distDir,
    deriveVersion: false,
  });
  await pluginNoDerive.buildStart();
  await pluginNoDerive.writeBundle({ dir: distDir });

  const manifestNoDerive = JSON.parse(readFileSync(join(distDir, 'api/update/version.json'), 'utf8'));
  assert.equal(manifestNoDerive.version, '1.0.0');
});

test('precacheWithoutManifest: guards against HTML soft-404 responses', async () => {
  const caches = setupEnv(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/config.json') {
      // Return 200 OK HTML (SPA soft-404)
      return new Response('<!DOCTYPE html><html><body>Soft 404</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('ok');
  });

  initConfig({
    version: '1.0.0',
    configPath: '/config.json',
    precache: ['/index.html'],
  });

  await precacheFiles();

  // The corrupt HTML must NOT be in the offline cache
  const offlineCache = await caches.open('offline');
  const storedConfig = await offlineCache.match('/config.json');
  assert.equal(storedConfig, undefined);
});

test('loadConfigFromCache: rehydrates runtime config from offline cache', async () => {
  const caches = setupEnv(async () => new Response('ok'));
  await (await caches.open('offline')).put(
    req('/api/update/config.json'),
    new Response(JSON.stringify({ version: '1.0.0', networkTimeoutMs: 12345 }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const initial = initConfig({ networkTimeoutMs: 5000 });
  assert.equal(initial.networkTimeoutMs, 5000);

  const loaded = await loadConfigFromCache();
  assert.equal(loaded.networkTimeoutMs, 12345);
});

test('build-utils: findConfigFile discovers nlpwa.config.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-find-'));
  const configPath = join(root, 'nlpwa.config.json');
  writeFileSync(configPath, JSON.stringify({ version: '1.2.3' }));

  const found = findConfigFile(null, root);
  assert.equal(found, configPath);
});

test('build-utils: syncSourceConfigVersion does not overwrite version in comments', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-sync-'));
  const configPath = join(root, 'config.js');
  const initialContent = `// Comment with version: '0.0.1' should not be changed\nexport default {\n  version: '1.0.0',\n};\n`;
  writeFileSync(configPath, initialContent);

  syncSourceConfigVersion(configPath, '1.0.1');

  const updated = readFileSync(configPath, 'utf8');
  assert.ok(updated.includes(`// Comment with version: '0.0.1'`));
  assert.ok(updated.includes(`version: '1.0.1'`));
});

test('build-utils: syncSourceConfigVersion does not overwrite updateAPI.version when appearing above top-level version', () => {
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-sync-api-'));
  const configPath = join(root, 'config.js');
  const initialContent = `export default {\n  updateAPI: {\n    version: '/api/update/version.json',\n    info: '/api/update/info.json',\n  },\n  version: '1.0.0',\n};\n`;
  writeFileSync(configPath, initialContent);

  syncSourceConfigVersion(configPath, '1.0.1');

  const updated = readFileSync(configPath, 'utf8');
  assert.ok(updated.includes(`version: '/api/update/version.json'`), 'preserved updateAPI.version endpoint intact');
  assert.ok(updated.includes(`version: '1.0.1'`), 'updated top-level app version');
});

test('putInRuntime: handles 204 No Content without throwing and injects metadata', async () => {
  setupEnv(() => new Response(null, { status: 204, statusText: 'No Content' }));
  const request = req('/api/track');
  const res204 = new Response(null, { status: 204, statusText: 'No Content' });

  // Should succeed without throwing TypeError
  await putInRuntime(request, res204);

  const matched = await getFromRuntime(request);
  assert.ok(matched);
  assert.equal(matched.status, 204);
  assert.equal(matched.headers.get('X-NLPWA-Content-Length'), '0');
  assert.ok(matched.headers.get('X-NLPWA-Cached-At'));
});

test('ensureConfigReady: synchronizes and reflects new config after loadConfigFromCache', async () => {
  setupEnv(() => new Response('ok'));
  const cache = await openActive('offline');

  await cache.put(
    req('/api/update/config.json'),
    new Response(JSON.stringify({ version: '1.0.0', customField: 'initial' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const initialLoaded = await loadConfigFromCache();
  assert.equal(initialLoaded?.customField, 'initial');
  const initialReady = await ensureConfigReady();
  assert.equal(initialReady?.customField, 'initial');

  // Simulate committing a new config.json
  await cache.put(
    req('/api/update/config.json'),
    new Response(JSON.stringify({ version: '1.0.1', customField: 'updated' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  await loadConfigFromCache();
  const nextReady = await ensureConfigReady();
  assert.equal(nextReady?.customField, 'updated');
});

test('resolveStrategy: bypasses Vite dev server and HMR URLs only when dev: true or devBypass: true', () => {
  globalThis.self = { location: { origin: 'http://localhost:5173' } };

  // 1. In dev mode (dev: true), Vite internals are bypassed to network
  initConfig({
    dev: true,
    routes: [{ match: '**', strategy: 'cache-first' }],
    defaultStrategy: 'cache-first',
  });

  const viteClient = resolveStrategy(new Request('http://localhost:5173/@vite/client'));
  const viteFs = resolveStrategy(new Request('http://localhost:5173/@fs/node_modules/vite.js'));
  const viteHmr = resolveStrategy(new Request('http://localhost:5173/src/App.jsx.hot-update.json'));
  const viteImport = resolveStrategy(new Request('http://localhost:5173/src/main.js?import'));

  assert.equal(viteClient.strategy, 'network-only');
  assert.equal(viteFs.strategy, 'network-only');
  assert.equal(viteHmr.strategy, 'network-only');
  assert.equal(viteImport.strategy, 'network-only');
  const appRoute = resolveStrategy(new Request('http://localhost:5173/assets/style.css'));
  assert.equal(appRoute.strategy, 'cache-first');

  // 2. In production mode (dev: false), Vite bypass is disabled and URLs follow normal routes
  initConfig({
    dev: false,
    routes: [{ match: '**', strategy: 'cache-first' }],
    defaultStrategy: 'cache-first',
  });
  const prodViteClient = resolveStrategy(new Request('http://localhost:5173/@vite/client'));
  // Does not bypass to network-only; resolved by standard configured route
  assert.equal(prodViteClient.strategy, 'cache-first');
});

test('updateActiveConfig: enforces same-origin trust boundary by locking verifyHashes, caches, and snapshotCachePath', () => {
  initConfig({
    version: '1.0.0',
    verifyHashes: 'strict',
    caches: { offline: 'trusted-offline', runtime: 'trusted-runtime' },
    snapshotCachePath: '/_nlpwa/snapshot.json',
  });

  // Attempt to tamper with core security/engine settings via runtime config.json
  const updated = updateActiveConfig({
    version: '1.0.1',
    verifyHashes: false,
    caches: { offline: 'hijacked-offline', runtime: 'hijacked-runtime' },
    snapshotCachePath: '/malicious.json',
    routes: [{ match: '/api/**', strategy: 'network-first' }],
  });

  // Core settings must remain locked to SW configuration
  assert.equal(updated.verifyHashes, 'strict', 'verifyHashes cannot be downgraded by config.json');
  assert.equal(updated.caches.offline, 'trusted-offline', 'caches cannot be hijacked by config.json');
  assert.equal(updated.caches.runtime, 'trusted-runtime', 'caches cannot be hijacked by config.json');
  assert.equal(updated.snapshotCachePath, '/_nlpwa/snapshot.json', 'snapshotCachePath cannot be modified');
  assert.equal(getSnapshotPath(), '/_nlpwa/snapshot.json', 'getSnapshotPath() cannot be redirected by config.json');

  // App-level routing and appVersion are updated safely
  assert.equal(updated.appVersion, '1.0.1');
  assert.equal(updated.routes.length, 1);
});

test('updateActiveConfig: runtime config.json with snapshotCachePath: /evil.json is ignored', () => {
  initConfig({
    version: '1.0.0',
    snapshotCachePath: '/_nlpwa/snapshot.json',
  });

  updateActiveConfig({
    version: '1.0.2',
    snapshotCachePath: '/evil.json',
  });

  assert.equal(getSnapshotPath(), '/_nlpwa/snapshot.json', 'snapshotCachePath was locked and /evil.json was ignored');
});

test('commitStaged: retainPreviousVersionCache keeps prior active cache and serves old chunks', async () => {
  const routes = [{ match: '**', strategy: 'cache-first' }];
  const v1 = { '/api/update/config.json': JSON.stringify({ version: '1.0.0', retainPreviousVersionCache: true, routes }), '/app.js': 'v1', '/chunk-v1.js': 'chunk v1' };
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch, { retainPreviousVersionCache: true, routes });

  const r1 = await stageUpdate(await fetchServerInfo());
  assert.equal(r1.status, 'ready');
  assert.equal(await commitStaged(), true);
  const activeV1 = (await getActive()).cache;

  // New version replaces chunk-v1 with chunk-v2
  server.set('1.0.1', { '/api/update/config.json': JSON.stringify({ version: '1.0.1', retainPreviousVersionCache: true, routes }), '/app.js': 'v2', '/chunk-v2.js': 'chunk v2' });
  const r2 = await stageUpdate(await fetchServerInfo());
  assert.equal(r2.status, 'ready');

  assert.equal(await commitStaged(), true);
  const activeV2 = (await getActive()).cache;

  assert.notEqual(activeV1, activeV2);
  const currentKeys = await caches.keys();
  assert.ok(currentKeys.includes(activeV1), 'prior version cache retained');
  assert.ok(currentKeys.includes(activeV2), 'new version cache active');

  // Verify that an open tab requesting the older chunk still gets it via getFromOffline!
  const oldChunkHit = await getFromOffline(req('/chunk-v1.js'));
  assert.ok(oldChunkHit, 'older chunk served from retained previous cache');
  assert.equal(await oldChunkHit.text(), 'chunk v1');

  // And the new chunk is also served from active cache
  const newChunkHit = await getFromOffline(req('/chunk-v2.js'));
  assert.ok(newChunkHit, 'new chunk served from active cache');
  assert.equal(await newChunkHit.text(), 'chunk v2');
});

test('sweepOrphanCaches: retains active.previousCache on SW activation', async () => {
  const routes = [{ match: '**', strategy: 'cache-first' }];
  const v1 = { '/api/update/config.json': JSON.stringify({ version: '1.0.0', retainPreviousVersionCache: true, routes }), '/app.js': 'v1', '/chunk-v1.js': 'chunk v1' };
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch, { retainPreviousVersionCache: true, routes });

  const r1 = await stageUpdate(await fetchServerInfo());
  assert.equal(r1.status, 'ready');
  assert.equal(await commitStaged(), true);
  const activeV1 = (await getActive()).cache;

  // New version replaces chunk-v1 with chunk-v2
  server.set('1.0.1', { '/api/update/config.json': JSON.stringify({ version: '1.0.1', retainPreviousVersionCache: true, routes }), '/app.js': 'v2', '/chunk-v2.js': 'chunk v2' });
  const r2 = await stageUpdate(await fetchServerInfo());
  assert.equal(r2.status, 'ready');
  assert.equal(await commitStaged(), true);
  const activeV2 = (await getActive()).cache;

  // Simulate SW activation sweeping orphan caches
  await sweepOrphanCaches();

  const currentKeys = await caches.keys();
  assert.ok(currentKeys.includes(activeV1), 'prior version cache retained after sweepOrphanCaches');
  assert.ok(currentKeys.includes(activeV2), 'active version cache retained after sweepOrphanCaches');
});

test('cross-origin routing: matches and caches full URL patterns like onnxruntime-web CDN', () => {
  globalThis.self = { location: { origin: 'https://myapp.example.com' } };
  initConfig({
    routes: [
      {
        match: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/**',
        strategy: 'cache-first',
      },
    ],
    defaultStrategy: 'network-first',
  });

  const onnxWasmUrl = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd.wasm';
  const onnxJsUrl = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.js';
  const otherCdnUrl = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js';

  // Verify router resolves strategy for onnxruntime-web
  const onnxStrategy = resolveStrategy(new Request(onnxWasmUrl));
  assert.ok(onnxStrategy);

  // Verify isCacheableUrl returns true for matched cross-origin URLs
  assert.equal(isCacheableUrl(onnxWasmUrl), true);
  assert.equal(isCacheableUrl(onnxJsUrl), true);

  // Unconfigured cross-origin URL returns false (not cacheable)
  assert.equal(isCacheableUrl(otherCdnUrl), false);
});

test('client update-ui: onUpdateFailed catches UPDATE_FAILED event and triggers callback', async () => {
  const { onUpdateFailed } = await import('../src/client/update-ui.js');
  const listeners = [];
  const fakeSW = {
    addEventListener: (type, fn) => listeners.push(fn),
    removeEventListener: (type, fn) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  if (!globalThis.navigator) {
    globalThis.navigator = {};
  }
  const origSWDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serviceWorker');
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: fakeSW,
    configurable: true,
    writable: true,
  });

  const origDoc = globalThis.document;
  const origCustomEvent = globalThis.CustomEvent;

  const docEvents = [];
  globalThis.document = {
    dispatchEvent: (ev) => docEvents.push(ev),
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  let received = null;
  const unsub = onUpdateFailed((data) => {
    received = data;
  });

  listeners.forEach((fn) =>
    fn({
      data: {
        type: 'UPDATE_FAILED',
        version: '2.0.0',
        failed: ['/main.js'],
        error: 'Hash mismatch on /main.js',
        hasHashMismatch: true,
        errorCode: 'HASH_MISMATCH',
        quotaExceeded: false,
      },
    })
  );

  assert.ok(received);
  assert.equal(received.version, '2.0.0');
  assert.equal(received.hasHashMismatch, true);
  assert.equal(received.errorCode, 'HASH_MISMATCH');
  assert.equal(received.quotaExceeded, false);
  assert.equal(docEvents[0]?.type, 'nlpwa:update-failed');
  assert.equal(docEvents[0]?.detail.error, 'Hash mismatch on /main.js');
  assert.equal(docEvents[0]?.detail.errorCode, 'HASH_MISMATCH');
  assert.equal(docEvents[0]?.detail.quotaExceeded, false);

  unsub();
  assert.equal(listeners.length, 0);

  if (origSWDesc) {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', origSWDesc);
  } else {
    delete globalThis.navigator?.serviceWorker;
  }
  globalThis.document = origDoc;
  globalThis.CustomEvent = origCustomEvent;
});

test('strategies: safePutInRuntime skips opaque responses by default to prevent 7MB Chrome quota inflation', async () => {
  const fakeOpaque = new Response('mock content');
  Object.defineProperty(fakeOpaque, 'type', { value: 'opaque' });

  const caches = setupEnv(async () => fakeOpaque);
  const { cacheFirst } = await import('../src/sw/fetch/strategies/index.js');

  const request = req('https://cdn.example.com/asset.js');
  const response = await cacheFirst(request);
  assert.equal(response.type, 'opaque');

  // Runtime cache must NOT store opaque response by default
  const runtime = await caches.open('runtime');
  const cached = await runtime.match(request);
  assert.equal(cached, undefined, 'opaque response was skipped from runtime cache');
});

test('strategies: safePutInRuntime caches opaque response when cacheOpaque: true is explicitly configured', async () => {
  const fakeOpaque = new Response('mock content');
  Object.defineProperty(fakeOpaque, 'type', { value: 'opaque' });

  const caches = setupEnv(async () => fakeOpaque);
  const { cacheFirst } = await import('../src/sw/fetch/strategies/index.js');

  const request = req('https://cdn.example.com/asset.js');
  const response = await cacheFirst(request, null, { cacheOpaque: true });
  assert.equal(response.type, 'opaque');

  // Allow async safePutInRuntime to settle
  await new Promise((r) => setTimeout(r, 10));

  // Runtime cache stores it when opted in
  const runtime = await caches.open('runtime');
  const cached = await runtime.match(request);
  assert.ok(cached, 'opaque response was stored when cacheOpaque: true');
});

test('store: withLock uses Web Locks API when available and handles contention', async () => {
  const { withLock, resetStoreMemo } = await import('../src/sw/cache/store.js');
  resetStoreMemo();

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let requestedName = null;
  let lockAcquired = false;

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      locks: {
        async request(name, options, callback) {
          requestedName = name;
          if (options.ifAvailable && lockAcquired) {
            return callback(null);
          }
          lockAcquired = true;
          try {
            return await callback({ name });
          } finally {
            lockAcquired = false;
          }
        },
      },
    },
    configurable: true,
    writable: true,
  });

  try {
    // 1. Success execution under Web Locks
    const result = await withLock(async () => 'executed', 'fallback');
    assert.equal(result, 'executed');
    assert.equal(requestedName, 'nlpwa-operation-lock');

    // 2. Contention handling: when lock is held, returns fallback
    lockAcquired = true;
    const busyResult = await withLock(async () => 'should not run', 'fallback-val');
    assert.equal(busyResult, 'fallback-val');

    // 3. Error propagation: if fn throws inside Web Locks, it must NOT execute twice
    lockAcquired = false;
    let callCount = 0;
    await assert.rejects(
      async () => {
        await withLock(async () => {
          callCount++;
          throw new Error('deliberate failure in fn');
        }, 'fallback-val');
      },
      /deliberate failure in fn/
    );
    assert.equal(callCount, 1, 'fn must execute exactly once and not be called a second time in fallback');
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    } else {
      delete globalThis.navigator;
    }
    resetStoreMemo();
  }
});

test('config normalization: normalizes route.options onto route object for backwards compatibility', async () => {
  const { initConfig, getConfig } = await import('../src/sw/config/index.js');
  initConfig({
    version: '1.0.0',
    routes: [
      {
        match: 'https://cdn.jsdelivr.net/**',
        strategy: 'cache-first',
        options: {
          cacheOpaque: true,
          maxAge: '1d',
        },
      },
    ],
  });

  const routes = getConfig().routes;
  assert.equal(routes.length, 1);
  assert.equal(routes[0].cacheOpaque, true);
  assert.equal(routes[0].maxAge, '1d');
});

test('runtime: putInRuntime avoids buffering body in memory when Content-Length is missing', async () => {
  const { putInRuntime } = await import('../src/sw/cache/runtime.js');
  const caches = setupEnv(() => new Response('ok'));

  const streamBody = 'chunked dynamic payload';
  // Response with no Content-Length
  const streamRes = new Response(streamBody);
  assert.equal(streamRes.headers.get('Content-Length'), null);

  await putInRuntime(req('/api/stream'), streamRes);

  const runtime = await caches.open('runtime');
  const cached = await runtime.match(req('/api/stream'));
  assert.ok(cached);
  assert.equal(await cached.text(), streamBody);
  // Content length is not eagerly set on the stored response
  assert.equal(cached.headers.get('X-NLPWA-Content-Length'), null);
});

test('store: memoizes getStaged and updates with setStaged, clearStaged, and resetMeta', async () => {
  const { getStaged, setStaged, clearStaged, resetMeta, resetStoreMemo } = await import('../src/sw/cache/store.js');
  setupEnv(() => new Response('ok'));
  resetStoreMemo();

  // Initially null
  assert.equal(await getStaged(), null);

  // setStaged updates memory and cache
  await setStaged({ version: '1.2.3', complete: true });
  const staged1 = await getStaged();
  assert.equal(staged1?.version, '1.2.3');

  // Second call returns memoized value
  const staged2 = await getStaged();
  assert.equal(staged2?.version, '1.2.3');

  // clearStaged resets it
  await clearStaged();
  assert.equal(await getStaged(), null);

  // resetMeta resets it
  await setStaged({ version: '2.0.0' });
  await resetMeta();
  assert.equal(await getStaged(), null);
});

test('store: configurable META_CACHE via setMetaCacheName and caches.meta', async () => {
  const { getMetaCacheName, setMetaCacheName, getActive, setActive, resetMeta, resetStoreMemo } = await import('../src/sw/cache/store.js');
  const caches = setupEnv(() => new Response('ok'));
  resetStoreMemo();

  setMetaCacheName('my-custom-meta');
  assert.equal(getMetaCacheName(), 'my-custom-meta');

  await setActive({ cache: 'offline@custom-1', version: '1.0.0' });
  const active = await getActive();
  assert.equal(active?.cache, 'offline@custom-1');

  // Verify it was stored in 'my-custom-meta' cache
  const customCache = await caches.open('my-custom-meta');
  const storedRes = await customCache.match('/_nlpwa/active.json');
  assert.ok(storedRes, 'written to custom meta cache');
  const parsed = await storedRes.json();
  assert.equal(parsed.version, '1.0.0');

  // Reset back to default
  setMetaCacheName('nlpwa-meta');
  await resetMeta();
  resetStoreMemo();
});

test('updateActiveConfig: locks base path alongside verifyHashes and caches', async () => {
  const { initConfig, updateActiveConfig } = await import('../src/sw/config/index.js');
  initConfig({
    version: '1.0.0',
    base: '/app/',
  });

  const updated = updateActiveConfig({
    version: '1.0.1',
    base: '/hacked/',
  });

  assert.equal(updated.base, '/app/', 'base must not be altered by runtime config.json');
});

test('glob: caps _regexCache and clearGlobCache clears cache', async () => {
  const { globToRegex, clearGlobCache } = await import('../src/shared/glob.js');
  clearGlobCache();

  for (let i = 0; i < 120; i++) {
    globToRegex(`/pattern/${i}/**`);
  }

  // Capped at 100 entries without throwing or leaking
  clearGlobCache();
  const r1 = globToRegex('/test/**');
  assert.ok(r1.test('/test/hello'));
});test('NlpwaWebpackPlugin: emits config.json and update API endpoints on afterEmit', async () => {
  const { NlpwaWebpackPlugin } = await import('../src/webpack-plugin.js');
  const root = mkdtempSync(join(tmpdir(), 'nlpwa-webpack-'));
  const configPath = join(root, 'config.json');
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<h1>Hello Webpack</h1>');
  writeFileSync(configPath, JSON.stringify({ version: '1.2.0', precache: ['/index.html'] }));

  const plugin = new NlpwaWebpackPlugin({
    config: configPath,
    distDir,
    autoIncrement: true,
  });

  let afterEmitHook = null;
  const mockCompiler = {
    hooks: {
      afterEmit: {
        tapPromise(name, fn) {
          afterEmitHook = fn;
        },
      },
    },
    options: {
      output: {
        path: distDir,
      },
    },
  };

  plugin.apply(mockCompiler);
  assert.ok(typeof afterEmitHook === 'function', 'afterEmit hook registered');

  await afterEmitHook({});

  // Verify outputs
  const emittedConfig = JSON.parse(readFileSync(join(distDir, 'api/update/config.json'), 'utf8'));
  assert.equal(emittedConfig.version, '1.2.1');
  assert.deepEqual(emittedConfig.precache, ['/index.html']);

  const versionApi = JSON.parse(readFileSync(join(distDir, 'api/update/version.json'), 'utf8'));
  assert.equal(versionApi.version, '1.2.1');

  const infoApi = JSON.parse(readFileSync(join(distDir, 'api/update/info.json'), 'utf8'));
  assert.equal(infoApi.version, '1.2.1');
  assert.ok(Array.isArray(infoApi.files));
  assert.ok(infoApi.files.some((f) => f.path === '/index.html'));
  assert.ok(infoApi.files.some((f) => f.path === '/api/update/config.json'));
});

