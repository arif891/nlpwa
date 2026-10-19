import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { handleFetch } from '../src/sw/fetch/index.js';
import { getActive, getStaged } from '../src/sw/cache/store.js';
import { getFromOffline, getFromRuntime, putInRuntime, evictFromRuntime } from '../src/sw/cache/runtime.js';
import { resolvePathWithBase } from '../src/shared/url.js';
import { resolveStrategy } from '../src/sw/fetch/router.js';
import { isCacheableUrl, evictByRoute } from '../src/sw/cache/evict.js';

// Node's Request refuses mode 'navigate', so present a normal request as one
const asNavigation = (r) => new Proxy(r, {
  get: (t, k) => (k === 'mode' ? 'navigate' : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
});

const navigate = async (path = '/') => {
  let responded;
  handleFetch({ request: asNavigation(req(path)), respondWith: (p) => { responded = p; }, waitUntil() {} });
  return responded;
};

function makeSubpathServer(base, version, files) {
  const inner = makeServer(version, files);
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;

  const server = {
    inner,
    calls: [],
    set(v, f) { inner.set(v, f); },
    fetch: async (r) => {
      const pathname = new URL(r.url).pathname;
      server.calls.push(pathname);

      if (pathname.startsWith(cleanBase)) {
        const subpath = pathname.slice(cleanBase.length) || '/';
        const strippedReq = new Request(new URL(subpath, 'https://example.com'), r);
        return inner.fetch(strippedReq);
      }

      // If requested without base prefix on subpath hosting, return 404 (origin root has no app files)
      return new Response('Not found on origin root (missing subpath base)', { status: 404 });
    },
  };
  return server;
}

test('resolvePathWithBase helper handles all URL and base formats', () => {
  assert.equal(resolvePathWithBase('/app.js', '/my-app/'), '/my-app/app.js');
  assert.equal(resolvePathWithBase('app.js', '/my-app/'), '/my-app/app.js');
  assert.equal(resolvePathWithBase('/my-app/app.js', '/my-app/'), '/my-app/app.js');
  assert.equal(resolvePathWithBase('/my-app', '/my-app/'), '/my-app');
  assert.equal(resolvePathWithBase('/my-app/', '/my-app/'), '/my-app/');
  assert.equal(resolvePathWithBase('https://cdn.example.com/x.js', '/my-app/'), 'https://cdn.example.com/x.js');
  assert.equal(resolvePathWithBase('//cdn.example.com/x.js', '/my-app/'), '//cdn.example.com/x.js');
  assert.equal(resolvePathWithBase('/app.js', ''), '/app.js');
  assert.equal(resolvePathWithBase('/app.js', null), '/app.js');
  assert.equal(resolvePathWithBase('', '/my-app/'), '');
});

test('install: first install under base: "/my-app/" prefixes staging fetches and succeeds', async () => {
  fakeSelf();
  const v1 = {
    '/config.json': JSON.stringify({
      base: '/my-app/',
      version: '1.0.0',
      routes: [{ match: '**', strategy: 'cache-first' }],
      precache: ['/app.js', '/index.html'],
    }),
    '/app.js': 'console.log("app v1");',
    '/index.html': '<!DOCTYPE html><html><head><title>App</title></head><body><h1>Hello</h1></body></html>',
  };

  const server = makeSubpathServer('/my-app/', '1.0.0', v1);
  setupEnv(server.fetch, {
    base: '/my-app/',
    version: '1.0.0',
  });

  const result = await precacheFiles();
  assert.equal(result.status, 'ready');

  // Verify that all network calls made during install started with /my-app/
  assert.ok(server.calls.length >= 3, 'manifest, config, and assets must be fetched');
  for (const call of server.calls) {
    assert.ok(call.startsWith('/my-app/'), `Expected "${call}" to start with "/my-app/"`);
  }

  // Verify active version is committed
  const active = await getActive();
  assert.equal(active.version, '1.0.0');

  // Verify offline retrieval works with subpath URL
  const appRes = await getFromOffline('https://example.com/my-app/app.js');
  assert.ok(appRes, 'Subpath asset must be retrievable from offline cache');
  assert.equal(await appRes.text(), 'console.log("app v1");');

  // Verify root subpath retrieval works
  const rootRes = await getFromOffline('https://example.com/my-app/');
  assert.ok(rootRes, 'Subpath root must resolve to cached index.html');
  assert.match(await rootRes.text(), /Hello/);
});

test('install: fallback precache without manifest under base: "/my-app/" prefixes fetches', async () => {
  fakeSelf();
  const v1 = {
    '/config.json': JSON.stringify({
      base: '/my-app/',
      version: '1.0.0',
      routes: [{ match: '**', strategy: 'cache-first' }],
      precache: ['/app.js'],
    }),
    '/app.js': 'console.log("fallback app v1");',
  };

  const server = makeSubpathServer('/my-app/', '1.0.0', v1);
  setupEnv(async (r) => {
    // Hide update endpoints to trigger precacheWithoutManifest
    if (new URL(r.url).pathname.includes('/api/update')) {
      return new Response('Not found', { status: 404 });
    }
    return server.fetch(r);
  }, {
    base: '/my-app/',
    version: '1.0.0',
    configPath: '/config.json',
    precache: ['/app.js'],
  });

  const result = await precacheFiles();
  assert.equal(result.status, 'ready');

  for (const call of server.calls) {
    assert.ok(call.startsWith('/my-app/'), `Expected fallback fetch "${call}" to start with "/my-app/"`);
  }

  const appRes = await getFromOffline('https://example.com/my-app/app.js');
  assert.ok(appRes);
  assert.equal(await appRes.text(), 'console.log("fallback app v1");');
});

test('update: two-tier check and staging under base: "/my-app/" prefixes all endpoints and downloads', async () => {
  fakeSelf();
  const v1 = {
    '/config.json': JSON.stringify({
      base: '/my-app/',
      version: '1.0.0',
      precache: ['/app.js'],
    }),
    '/app.js': 'console.log("v1");',
  };
  const v2 = {
    '/config.json': JSON.stringify({
      base: '/my-app/',
      version: '1.0.1',
      precache: ['/app.js'],
    }),
    '/app.js': 'console.log("v2 updated code");',
  };

  const server = makeSubpathServer('/my-app/', '1.0.0', v1);
  setupEnv(server.fetch, {
    base: '/my-app/',
    version: '1.0.0',
  });

  await precacheFiles();
  assert.equal((await getActive()).version, '1.0.0');

  // Server upgrades to v2
  server.set('1.0.1', v2);
  server.calls.length = 0;

  const updateResult = await checkForUpdate();
  assert.equal(updateResult.updated, true);
  assert.equal(updateResult.version, '1.0.1');

  // Verify all calls were prefixed with /my-app/
  assert.ok(server.calls.includes('/my-app/api/update/version.json'));
  assert.ok(server.calls.includes('/my-app/api/update/info.json'));
  assert.ok(server.calls.includes('/my-app/app.js'));
  for (const call of server.calls) {
    assert.ok(call.startsWith('/my-app/'), `Expected "${call}" to start with "/my-app/"`);
  }

  // Staged update is waiting
  const staged = await getStaged();
  assert.equal(staged.version, '1.0.1');
  assert.equal(staged.complete, true);

  // Switch happens on navigation
  await navigate('/my-app/');
  assert.equal((await getActive()).version, '1.0.1');

  const appRes = await getFromOffline('https://example.com/my-app/app.js');
  assert.equal(await appRes.text(), 'console.log("v2 updated code");');
});

test('subpath base: route matching strips base prefix so app-relative routes match', () => {
  fakeSelf();
  setupEnv(() => new Response('ok'), {
    base: '/my-app/',
    version: '1.0.0',
    routes: [
      { match: '/assets/**', strategy: 'cache-first' },
      { match: '/api/**', strategy: 'network-first' },
    ],
  });

  const assetHandler = resolveStrategy(req('https://example.com/my-app/assets/logo.png'));
  assert.equal(assetHandler.strategy, 'cache-first');

  const apiHandler = resolveStrategy(req('https://example.com/my-app/api/user'));
  assert.equal(apiHandler.strategy, 'network-first');

  assert.equal(isCacheableUrl('https://example.com/my-app/assets/logo.png'), true);
});

test('subpath base: evictFromRuntime deletes both raw path and base-prefixed path', async () => {
  fakeSelf();
  const caches = setupEnv(() => new Response('ok'), {
    base: '/my-app/',
    version: '1.0.0',
  });

  const runtime = await caches.open('runtime');
  await runtime.put('https://example.com/my-app/assets/bundle.js', new Response('content 1'));
  await runtime.put('/assets/bundle.js', new Response('content 2'));

  assert.ok(await runtime.match('/my-app/assets/bundle.js'));
  assert.ok(await runtime.match('/assets/bundle.js'));

  await evictFromRuntime(['/assets/bundle.js']);

  assert.equal(await runtime.match('/my-app/assets/bundle.js'), undefined);
  assert.equal(await runtime.match('/assets/bundle.js'), undefined);
});

test('subpath base: getApiDiskPath strips base prefix so disk files are written to targetDir/api/... not targetDir/my-app/api/...', async () => {
  const { getApiDiskPath } = await import('../src/cli/core/manifest.js');
  const { resolveUpdateEndpoints } = await import('../src/shared/url.js');
  const runtimeConfig = { base: '/my-app/', version: '1.0.0' };
  const { versionEndpoint, infoEndpoint } = resolveUpdateEndpoints(runtimeConfig);
  assert.equal(versionEndpoint, '/my-app/api/update/version.json');
  assert.equal(infoEndpoint, '/my-app/api/update/info.json');

  const { resolve } = await import('node:path');
  const versionDiskPath = getApiDiskPath('dist', versionEndpoint, runtimeConfig.base);
  const infoDiskPath = getApiDiskPath('dist', infoEndpoint, runtimeConfig.base);
  assert.equal(versionDiskPath, resolve('dist', 'api/update/version.json'));
  assert.equal(infoDiskPath, resolve('dist', 'api/update/info.json'));
});

