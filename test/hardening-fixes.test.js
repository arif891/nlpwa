import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent } from './helpers/fake-env.js';
import { fakeSelf } from './helpers/fake-server.js';
import { networkFirst, cacheOnly, staleWhileRevalidate } from '../src/sw/fetch/strategies/index.js';
import { isManifestFile, matchRoute } from '../src/sw/fetch/router.js';
import { createRangeResponse } from '../src/sw/fetch/range.js';
import { fetchServerVersion, resetManifestMemo } from '../src/sw/update/manifest.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { initConfig } from '../src/sw/config/index.js';

test('1.1: networkFirst with maxAge unwraps cached.response on offline fallback without TypeError', async () => {
  const caches = setupEnv(async () => {
    throw new TypeError('Network down');
  });

  const runtime = await caches.open('runtime');
  // Store an expired entry (cached 2 hours ago with maxAge = 1 hour)
  const expiredTime = Date.now() - 2 * 3600 * 1000;
  await runtime.put(
    req('https://example.com/api/data'),
    new Response(JSON.stringify({ value: 'old-data' }), {
      headers: {
        'Content-Type': 'application/json',
        'X-NLPWA-Cached-At': String(expiredTime),
      },
    })
  );

  const res = await networkFirst(req('https://example.com/api/data'), fakeEvent(), {
    maxAge: '1h',
  });

  assert.ok(res instanceof Response, 'Result must be a Response instance, not a plain object');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.value, 'old-data');
});

test('1.1: cacheOnly unwraps cached.response when maxAge is set without TypeError', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');
  const expiredTime = Date.now() - 2 * 3600 * 1000;
  await runtime.put(
    req('https://example.com/offline-data'),
    new Response('offline-content', {
      headers: {
        'X-NLPWA-Cached-At': String(expiredTime),
      },
    })
  );

  const res = await cacheOnly(req('https://example.com/offline-data'), fakeEvent(), {
    maxAge: '1h',
  });

  assert.ok(res instanceof Response, 'cacheOnly must return a Response instance');
  assert.equal(await res.text(), 'offline-content');
});

test('1.3: staleWhileRevalidate respects fallbackOn5xx when cache entry has expired', async () => {
  setupEnv(async () => {
    return new Response('Server Error', { status: 502, statusText: 'Bad Gateway' });
  });

  const caches = setupEnv();
  const runtime = await caches.open('runtime');
  const expiredTime = Date.now() - 2 * 3600 * 1000;
  await runtime.put(
    req('https://example.com/api/feed'),
    new Response('stale-feed-data', {
      headers: {
        'X-NLPWA-Cached-At': String(expiredTime),
      },
    })
  );

  const res = await staleWhileRevalidate(req('https://example.com/api/feed'), fakeEvent(), {
    maxAge: '1h',
    fallbackOn5xx: true,
  });

  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'stale-feed-data');
  assert.equal(res.headers.get('X-Cache-Status'), 'stale');
});

test('1.4: subpath base prefix boundary check prevents collisions on similar prefixes', () => {
  const config = {
    base: '/app',
    routes: [
      { match: '/dashboard/**', strategy: 'cache-first' },
      { match: '/settings', strategy: 'network-first' },
    ],
  };

  // /apple-touch-icon.png starts with /app, but does NOT match the base boundary (/app/)
  const isManifest = isManifestFile(new URL('https://example.com/apple-touch-icon.png'), config);
  assert.equal(isManifest, false);

  // /app-settings starts with /app, but should NOT match route /settings
  const matched = matchRoute(new URL('https://example.com/app-settings'), config.routes, config);
  assert.equal(matched, null);

  // Exact base matches correctly
  const appMatched = matchRoute(new URL('https://example.com/app/settings'), config.routes, config);
  assert.ok(appMatched);
  assert.equal(appMatched.strategy, 'network-first');
});

test('2.1: createRangeResponse stream-slices ReadableStream when Content-Length is known', async () => {
  const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

  const original = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': '10',
    },
  });

  const request = new Request('https://example.com/video.mp4', {
    headers: { Range: 'bytes=2-6' },
  });

  const sliced = await createRangeResponse(request, original);
  assert.equal(sliced.status, 206);
  assert.equal(sliced.headers.get('Content-Range'), 'bytes 2-6/10');
  assert.equal(sliced.headers.get('Content-Length'), '5');
  const buffer = await sliced.arrayBuffer();
  assert.deepEqual(new Uint8Array(buffer), new Uint8Array([2, 3, 4, 5, 6]));
});

test('2.2: manifest 304 response preserves minVersion memoized from prior 200 OK', async () => {
  resetManifestMemo();
  initConfig({
    updateAPI: {
      version: '/api/version',
      info: '/api/info',
    },
  });

  let responseStatus = 200;
  setupEnv(async () => {
    if (responseStatus === 200) {
      return new Response(JSON.stringify({ version: '2.0.0', minVersion: '1.5.0' }), {
        status: 200,
        headers: {
          ETag: '"v2.0.0"',
          'Content-Type': 'application/json',
        },
      });
    }
    return new Response(null, {
      status: 304,
      headers: { ETag: '"v2.0.0"' },
    });
  });

  // First check: 200 OK
  const res1 = await fetchServerVersion();
  assert.equal(res1.version, '2.0.0');
  assert.equal(res1.minVersion, '1.5.0');

  // Second check: 304 Not Modified
  responseStatus = 304;
  const res2 = await fetchServerVersion();
  assert.equal(res2.notModified, true);
  assert.equal(res2.version, '2.0.0');
  assert.equal(res2.minVersion, '1.5.0');
});

test('2.3: subpath staging writes single canonical URL without duplicate cache entries', async () => {
  fakeSelf();
  const caches = setupEnv(async (r) => {
    return new Response(`content of ${r.url}`);
  }, {
    base: '/my-subpath/',
    verifyHashes: false,
  });

  const manifest = {
    version: '1.0.0',
    files: [
      { path: '/app.js', hash: 'e2ef37fb30fb840b7f0b0e928c11c82e' },
      { path: '/index.html', hash: '0d5935fe2be52a31faa15f52f5508363' },
    ],
  };

  const result = await stageUpdate(manifest, { verify: false });
  assert.equal(result.status, 'ready');

  const { getStaged } = await import('../src/sw/cache/store.js');
  const staged = await getStaged();
  assert.ok(staged?.cache);

  const stagedCache = await caches.open(staged.cache);
  const keys = await stagedCache.keys();
  const paths = keys.map((k) => new URL(k.url).pathname);

  // Manifest has 2 files + snapshot.json = 3 keys (no duplicate dual keys)
  assert.equal(paths.length, 3);
  assert.ok(paths.includes('/my-subpath/app.js'));
  assert.ok(paths.includes('/my-subpath/index.html'));
  assert.ok(!paths.includes('/app.js'), 'Must NOT write duplicate un-prefixed keys');
});

test('3.0: nlpwaPlugin propagates minVersion into emitted version.json and info.json', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { nlpwaPlugin } = await import('../src/rollup-plugin.js');

  const root = mkdtempSync(join(tmpdir(), 'nlpwa-minver-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    version: '2.0.0',
    minVersion: '1.5.0',
    precache: [],
  }));

  const distDir = join(root, 'dist');
  const plugin = nlpwaPlugin({
    config: configPath,
    distDir,
    version: '2.0.0',
  });

  await plugin.buildStart();
  await plugin.writeBundle({});

  const versionJson = JSON.parse(readFileSync(join(distDir, 'api', 'update', 'version.json'), 'utf8'));
  const infoJson = JSON.parse(readFileSync(join(distDir, 'api', 'update', 'info.json'), 'utf8'));

  assert.equal(versionJson.version, '2.0.0');
  assert.equal(versionJson.minVersion, '1.5.0');
  assert.equal(infoJson.version, '2.0.0');
  assert.equal(infoJson.minVersion, '1.5.0');
});
