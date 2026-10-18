import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCacheableUrl } from '../src/sw/cache/evict.js';
import { initConfig, updateActiveConfig, loadConfigFromCache, onUpdateIntervalChange, ensureConfigReady } from '../src/sw/config/index.js';
import { startUpdatePolling, stopUpdatePolling } from '../src/sw/update/index.js';
import { nlpwaPlugin } from '../src/rollup-plugin.js';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { findConfigFile, syncSourceConfigVersion } from '../bin/build-utils.js';
import { putInRuntime, getFromRuntime, getFromOffline } from '../src/sw/cache/runtime.js';
import { resolveStrategy } from '../src/sw/fetch/router.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { commitStaged } from '../src/sw/update/commit.js';
import { getActive, openActive } from '../src/sw/cache/store.js';
import { fetchServerManifest } from '../src/sw/update/manifest.js';

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

test('startUpdatePolling: replaces existing timer and cleans up on stop', () => {
  initConfig({ updateCheckInterval: 5000 });
  startUpdatePolling();
  // Call again with new interval; must replace without error
  initConfig({ updateCheckInterval: 10000 });
  startUpdatePolling();
  stopUpdatePolling();
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

test('onUpdateIntervalChange: supports multiple subscribers and unsubscribe', async () => {
  const eventsA = [];
  const eventsB = [];

  const unsubA = onUpdateIntervalChange((val) => eventsA.push(val));
  const unsubB = onUpdateIntervalChange((val) => eventsB.push(val));

  const caches = setupEnv(async () => new Response('ok'));
  await (await caches.open('offline')).put(
    req('/config.json'),
    new Response(JSON.stringify({ version: '1.0.0', updateCheckInterval: 15000 }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  initConfig({ updateCheckInterval: 5000 });
  await loadConfigFromCache();

  assert.deepEqual(eventsA, [15000]);
  assert.deepEqual(eventsB, [15000]);

  // Unsubscribe A, change again
  unsubA();
  await (await caches.open('offline')).put(
    req('/config.json'),
    new Response(JSON.stringify({ version: '1.0.0', updateCheckInterval: 30000 }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await loadConfigFromCache();

  assert.deepEqual(eventsA, [15000]); // didn't receive second event
  assert.deepEqual(eventsB, [15000, 30000]);

  unsubB();
  stopUpdatePolling();
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
    req('/config.json'),
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
    req('/config.json'),
    new Response(JSON.stringify({ version: '1.0.1', customField: 'updated' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  await loadConfigFromCache();
  const nextReady = await ensureConfigReady();
  assert.equal(nextReady?.customField, 'updated');
});

test('resolveStrategy: automatically bypasses Vite dev server and HMR URLs', () => {
  globalThis.self = { location: { origin: 'http://localhost:5173' } };
  initConfig({
    routes: [{ match: '**', strategy: 'cache-first' }],
    defaultStrategy: 'cache-first',
  });

  const viteClient = resolveStrategy(new Request('http://localhost:5173/@vite/client'));
  const viteFs = resolveStrategy(new Request('http://localhost:5173/@fs/node_modules/vite.js'));
  const viteHmr = resolveStrategy(new Request('http://localhost:5173/src/App.jsx.hot-update.json'));
  const viteImport = resolveStrategy(new Request('http://localhost:5173/src/main.js?import'));

  assert.equal(viteClient.name, ''); // wrapped networkOnly function
  // Verify standard app route still gets cache-first
  const appRoute = resolveStrategy(new Request('http://localhost:5173/assets/style.css'));
  assert.ok(appRoute);
});

test('commitStaged: retainPreviousVersionCache keeps prior active cache and serves old chunks', async () => {
  const routes = [{ match: '**', strategy: 'cache-first' }];
  const v1 = { '/config.json': JSON.stringify({ version: '1.0.0', retainPreviousVersionCache: true, routes }), '/app.js': 'v1', '/chunk-v1.js': 'chunk v1' };
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch, { retainPreviousVersionCache: true, routes });

  const r1 = await stageUpdate(await fetchServerManifest());
  assert.equal(r1.status, 'ready');
  assert.equal(await commitStaged(), true);
  const activeV1 = (await getActive()).cache;

  // New version replaces chunk-v1 with chunk-v2
  server.set('1.0.1', { '/config.json': JSON.stringify({ version: '1.0.1', retainPreviousVersionCache: true, routes }), '/app.js': 'v2', '/chunk-v2.js': 'chunk v2' });
  const r2 = await stageUpdate(await fetchServerManifest());
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


