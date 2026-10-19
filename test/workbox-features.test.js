import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent, sleep } from './helpers/fake-env.js';
import { createRangeResponse } from '../src/sw/fetch/range.js';
import { isNavigationFallbackAllowed } from '../src/sw/fetch/navigation.js';
import { cleanTrackingParams, DEFAULT_IGNORE_SEARCH_PARAMS } from '../src/sw/cache/keys.js';
import { networkFirst, cacheFirst, staleWhileRevalidate } from '../src/sw/fetch/strategies/index.js';
import { getFromRuntime, putInRuntime, matchWithAliases } from '../src/sw/cache/runtime.js';
import { cleanRuntimeCache } from '../src/sw/cache/cleanup.js';
import { initConfig } from '../src/sw/config/index.js';

test('range requests: createRangeResponse returns original response when no Range header', async () => {
  const original = new Response('Hello, world!');
  const request = new Request('http://localhost/video.mp4');
  const result = await createRangeResponse(request, original);
  assert.equal(result, original);
});

test('range requests: slices closed byte range (bytes=0-4) into 206 Partial Content', async () => {
  const original = new Response('0123456789', {
    headers: { 'Content-Type': 'video/mp4' },
  });
  const request = new Request('http://localhost/video.mp4', {
    headers: { Range: 'bytes=0-4' },
  });
  const result = await createRangeResponse(request, original);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Range'), 'bytes 0-4/10');
  assert.equal(result.headers.get('Content-Length'), '5');
  assert.equal(result.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(result.headers.get('Content-Type'), 'video/mp4');
  assert.equal(await result.text(), '01234');
});

test('range requests: slices open byte range (bytes=5-) into 206 Partial Content', async () => {
  const original = new Response('0123456789', {
    headers: { 'Content-Type': 'audio/mp3' },
  });
  const request = new Request('http://localhost/audio.mp3', {
    headers: { Range: 'bytes=5-' },
  });
  const result = await createRangeResponse(request, original);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Range'), 'bytes 5-9/10');
  assert.equal(result.headers.get('Content-Length'), '5');
  assert.equal(await result.text(), '56789');
});

test('range requests: slices suffix byte range (bytes=-3) into 206 Partial Content', async () => {
  const original = new Response('0123456789');
  const request = new Request('http://localhost/video.mp4', {
    headers: { Range: 'bytes=-3' },
  });
  const result = await createRangeResponse(request, original);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Range'), 'bytes 7-9/10');
  assert.equal(result.headers.get('Content-Length'), '3');
  assert.equal(await result.text(), '789');
});

test('range requests: returns 416 Range Not Satisfiable for out-of-bounds range', async () => {
  const original = new Response('0123456789');
  const request = new Request('http://localhost/video.mp4', {
    headers: { Range: 'bytes=20-30' },
  });
  const result = await createRangeResponse(request, original);
  assert.equal(result.status, 416);
  assert.equal(result.headers.get('Content-Range'), 'bytes */10');
});

test('range requests: cacheFirst serves 206 Partial Content for cached media when Range is requested', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');
  await runtime.put(
    req('/media/podcast.mp3'),
    new Response('ABCDEFGHIJ', { headers: { 'Content-Type': 'audio/mpeg' } })
  );

  const rangeReq = req('/media/podcast.mp3', {
    headers: { Range: 'bytes=2-5' },
  });
  const res = await cacheFirst(rangeReq, fakeEvent());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(await res.text(), 'CDEF');
});

test('navigation allowlist/denylist: isNavigationFallbackAllowed respects denylist and allowlist', () => {
  const config = {
    navigationDenylist: ['/api/**', '/admin/**', /^\/auth\//],
    navigationAllowlist: ['/app/**', '/dashboard'],
  };

  // Denylisted paths
  assert.equal(isNavigationFallbackAllowed('/api/v1/users', {}, config), false);
  assert.equal(isNavigationFallbackAllowed('/admin/dashboard', {}, config), false);
  assert.equal(isNavigationFallbackAllowed('/auth/callback', {}, config), false);

  // Outside allowlist
  assert.equal(isNavigationFallbackAllowed('/other/path', {}, config), false);

  // Allowed paths
  assert.equal(isNavigationFallbackAllowed('/app/overview', {}, config), true);
  assert.equal(isNavigationFallbackAllowed('/dashboard', {}, config), true);
});

test('navigation allowlist/denylist: denylist prevents offline SPA fallback on failed navigations', async () => {
  const caches = setupEnv(async () => { throw new TypeError('Network down'); });
  const offline = await caches.open('offline');
  await offline.put(req('/index.html'), new Response('<html>SPA Shell</html>', {
    headers: { 'Content-Type': 'text/html' },
  }));

  initConfig({
    offlineFallback: '/index.html',
    navigationDenylist: ['/api/**', '/admin/**'],
  });

  // Navigation request to /admin/settings (mode: 'navigate')
  const navReq = req('/admin/settings', {
    headers: { accept: 'text/html' },
  });
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });

  const res = await networkFirst(navReq, fakeEvent());
  // Should NOT return the SPA fallback /index.html because /admin/** is denylisted
  assert.equal(res.status, 503);
  assert.notEqual(await res.text(), '<html>SPA Shell</html>');
});

test('navigation preload: networkFirst consumes preloadResponse if provided by browser', async () => {
  let networkFetches = 0;
  setupEnv(async () => {
    networkFetches++;
    return new Response('from-network');
  });

  const event = fakeEvent();
  // Simulate browser's navigation preload promise
  event.preloadResponse = Promise.resolve(new Response('from-navigation-preload', {
    headers: { 'Content-Type': 'text/html' },
  }));

  const navReq = req('/dashboard', {
    headers: { accept: 'text/html' },
  });
  Object.defineProperty(navReq, 'mode', { value: 'navigate' });

  const res = await networkFirst(navReq, event);
  assert.equal(await res.text(), 'from-navigation-preload');
  assert.equal(res.headers.get('X-Cache-Status'), 'preload');
  // No additional network fetch was made because preload response was consumed
  assert.equal(networkFetches, 0);
});

test('cache key control: cleanTrackingParams strips marketing and analytics queries', () => {
  const dirtyUrl = 'http://localhost/page?utm_source=twitter&utm_medium=social&utm_campaign=launch&fbclid=IwAR123&keep=true&page=2';
  const cleanUrl = cleanTrackingParams(dirtyUrl);
  const parsed = new URL(cleanUrl);
  assert.equal(parsed.searchParams.get('utm_source'), null);
  assert.equal(parsed.searchParams.get('utm_medium'), null);
  assert.equal(parsed.searchParams.get('utm_campaign'), null);
  assert.equal(parsed.searchParams.get('fbclid'), null);
  assert.equal(parsed.searchParams.get('keep'), 'true');
  assert.equal(parsed.searchParams.get('page'), '2');
});

test('cache key control: matchWithAliases resolves directoryIndex and cleanURLs', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');

  // Store index.html under /docs/index.html and /about.html
  await runtime.put(req('/docs/index.html'), new Response('docs index'));
  await runtime.put(req('/about.html'), new Response('about page'));

  // Directory index matching /docs/ -> /docs/index.html
  const dirMatch = await matchWithAliases(runtime, req('/docs/'), undefined, undefined, { directoryIndex: 'index.html' });
  assert.ok(dirMatch);
  assert.equal(await dirMatch.text(), 'docs index');

  // Clean URLs matching /about -> /about.html
  const cleanMatch = await matchWithAliases(runtime, req('/about'), undefined, undefined, { cleanURLs: true });
  assert.ok(cleanMatch);
  assert.equal(await cleanMatch.text(), 'about page');
});

test('cache key control: getFromRuntime matches request stripped of tracking query parameters', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');

  // Asset was cached without tracking query params
  await runtime.put(req('/products/item'), new Response('product details'));

  // Client requests with tracking params
  const reqWithTracking = req('/products/item?utm_source=newsletter&utm_medium=email&gclid=xyz123');
  const match = await getFromRuntime(reqWithTracking);
  assert.ok(match);
  assert.equal(await match.text(), 'product details');
});

test('cache key control: cleanURLs resolves extensionless requests to .html by default and respects cleanURLs: false', async () => {
  const caches = setupEnv();
  const runtime = await caches.open('runtime');

  await runtime.put(req('/contact.html'), new Response('contact html content'));

  // By default, cleanURLs is true: /contact matches /contact.html
  initConfig({ cleanURLs: true });
  const hit = await getFromRuntime(req('/contact'));
  assert.ok(hit);
  assert.equal(await hit.text(), 'contact html content');

  // When cleanURLs is false, /contact must NOT match /contact.html
  initConfig({ cleanURLs: false });
  const miss = await getFromRuntime(req('/contact'));
  assert.equal(miss, undefined);
});

test('plugins: cacheKeyWillBeUsed hook customizes cache key on read and write', async () => {
  const caches = setupEnv(async (r) => new Response('data for ' + r.url));
  const runtime = await caches.open('runtime');

  // Plugin strips language prefix '/en/' from cache key
  const customKeyPlugin = {
    cacheKeyWillBeUsed({ request }) {
      const url = new URL(request.url || request);
      url.pathname = url.pathname.replace(/^\/en/, '');
      return url.href;
    },
  };

  const event1 = fakeEvent();
  const response = await cacheFirst(req('/en/profile'), event1, {
    plugins: [customKeyPlugin],
  });
  assert.ok(response);
  await event1.settle();

  // Cache key stored in runtime cache should be /profile, not /en/profile
  const directHit = await runtime.match(req('/profile'));
  assert.ok(directHit, 'Item should be cached under rewritten cache key /profile');

  // A subsequent request with /en/profile should hit the cache via the plugin
  const cacheHit = await cacheFirst(req('/en/profile'), fakeEvent(), {
    plugins: [customKeyPlugin],
  });
  assert.equal(cacheHit.headers.get('X-Cache-Status'), 'runtime-cache');
});

test('route maxEntries: cleanRuntimeCache supports scoped pattern matching and maxEntries for on-demand cleanup', async () => {
  const caches = setupEnv(async (r) => new Response('res for ' + r.url));
  const runtime = await caches.open('runtime');

  // Add 3 items matching /items/**
  await cacheFirst(req('/items/1'), fakeEvent());
  await sleep(10);
  await cacheFirst(req('/items/2'), fakeEvent());
  await sleep(10);
  await cacheFirst(req('/items/3'), fakeEvent());
  await sleep(10);

  // Add an unrelated item /other/page that should not be touched
  await cacheFirst(req('/other/page'), fakeEvent());
  await sleep(10);

  let keys = await runtime.keys();
  assert.equal(keys.length, 4);

  // Run on-demand scoped cleanup with maxEntries: 2 for /items/**
  await cleanRuntimeCache({
    strategy: 'lru',
    maxEntries: 2,
    match: '/items/**',
  });

  keys = await runtime.keys();
  assert.equal(keys.length, 3);
  const remainingUrls = keys.map((k) => new URL(k.url).pathname);
  assert.ok(!remainingUrls.includes('/items/1'), '/items/1 should have been evicted as the oldest item matching pattern');
  assert.ok(remainingUrls.includes('/items/2'));
  assert.ok(remainingUrls.includes('/items/3'));
  assert.ok(remainingUrls.includes('/other/page'), 'Unrelated route /other/page should not be affected');
});

test('stale-while-revalidate: onRevalidated callback fires after background revalidation', async () => {
  let fetchCount = 0;
  const caches = setupEnv(async (r) => {
    fetchCount++;
    return new Response(`version ${fetchCount}`);
  });
  const runtime = await caches.open('runtime');
  await runtime.put(req('/feed'), new Response('stale feed', {
    headers: { 'X-NLPWA-Cached-At': String(Date.now()) },
  }));

  let revalidatedData = null;
  const event = fakeEvent();

  const served = await staleWhileRevalidate(req('/feed'), event, {
    onRevalidated(data) {
      revalidatedData = data;
    },
  });

  // Served stale response immediately
  assert.equal(await served.text(), 'stale feed');
  assert.equal(served.headers.get('X-Cache-Status'), 'stale');

  // Wait for background revalidate promise in event.waitUntil
  await event.settle();

  assert.ok(revalidatedData, 'onRevalidated callback should have been invoked');
  assert.equal(await revalidatedData.response.clone().text(), 'version 1');
});

test('config schema: validateConfig accepts newly added route and top-level options without error', async () => {
  const { validateConfig } = await import('../src/sw/config/schema.js');
  const { DEFAULTS } = await import('../src/sw/config/defaults.js');
  const validConfig = {
    ...DEFAULTS,
    version: '1.0.0',
    minVersion: '1.0.0',
    minSupportedVersion: '1.0.0',
    cacheKeyWillBeUsed: () => {},
    onPush: () => {},
    onNotificationClick: () => {},
    routes: [
      {
        match: '/api/**',
        strategy: 'network-first',
        fallbackOn5xx: true,
        cacheKeyWillBeUsed: () => {},
        onRevalidated: () => {},
      },
    ],
  };

  const errors = validateConfig(validConfig);
  assert.equal(errors.length, 0, `Expected 0 validation errors, got: ${errors.join(', ')}`);
});

test('matchWithAliases: skips relative path aliases for cross-origin requests', async () => {
  setupEnv(() => new Response('ok'));
  const caches = globalThis.caches;
  const runtime = await caches.open('runtime');

  // Cache a cross-origin URL
  const cdnUrl = 'https://cdn.example.org/lib/app.js';
  await runtime.put(cdnUrl, new Response('cdn script'));

  // A request to https://cdn.example.org/lib/ should NOT match /lib/index.html on app origin
  const matched = await matchWithAliases(runtime, req('https://cdn.example.org/lib/'));
  assert.equal(matched, undefined);
});


