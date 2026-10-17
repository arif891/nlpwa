import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCacheableUrl } from '../src/sw/cache/evict.js';
import { initConfig, updateActiveConfig, loadConfigFromCache, onUpdateIntervalChange } from '../src/sw/config/index.js';
import { startUpdatePolling, stopUpdatePolling } from '../src/sw/update/index.js';
import { nlpwaPlugin } from '../src/rollup-plugin.js';
import { setupEnv, req } from './helpers/fake-env.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { findConfigFile, syncSourceConfigVersion } from '../bin/build-utils.js';

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
