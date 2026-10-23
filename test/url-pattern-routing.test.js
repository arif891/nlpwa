import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req, fakeEvent } from './helpers/fake-env.js';
import { fakeSelf } from './helpers/fake-server.js';
import { matchRoute, resolveStrategy, isManifestFile, compileRoutePattern } from '../src/sw/fetch/router.js';
import { initConfig } from '../src/sw/config/index.js';
import { validateConfig } from '../src/sw/config/schema.js';

test('compileRoutePattern: builds and caches URLPattern instances', () => {
  const route = { match: '/api/:version/users/:id', strategy: 'network-first' };
  const p1 = compileRoutePattern(route);
  assert.ok(p1 instanceof URLPattern);
  const p2 = compileRoutePattern(route);
  assert.equal(p1, p2, 'should be cached in WeakMap');

  // String pattern caching
  const s1 = compileRoutePattern('/files/*');
  const s2 = compileRoutePattern('/files/*');
  assert.equal(s1, s2, 'string patterns should be cached');
});

test('URLPattern routing: extracts named path parameters', () => {
  const routes = [
    { match: '/users/:id', strategy: 'cache-first' },
    { match: '/api/:version/:resource/:id', strategy: 'network-first' },
  ];

  const match1 = matchRoute(new URL('http://localhost/users/42'), routes);
  assert.ok(match1);
  assert.equal(match1.strategy, 'cache-first');
  assert.deepEqual(match1.params, { id: '42' });

  const match2 = matchRoute(new URL('http://localhost/api/v1/posts/99'), routes);
  assert.ok(match2);
  assert.equal(match2.strategy, 'network-first');
  assert.deepEqual(match2.params, { version: 'v1', resource: 'posts', id: '99' });
});

test('URLPattern routing: regex constrained route matching', () => {
  const routes = [
    { match: '/items/:id(\\d+)', strategy: 'cache-first' },
    { match: '/items/:slug', strategy: 'network-first' },
  ];

  const numericMatch = matchRoute(new URL('http://localhost/items/12345'), routes);
  assert.ok(numericMatch);
  assert.equal(numericMatch.strategy, 'cache-first');
  assert.deepEqual(numericMatch.params, { id: '12345' });

  const slugMatch = matchRoute(new URL('http://localhost/items/blue-shirt'), routes);
  assert.ok(slugMatch);
  assert.equal(slugMatch.strategy, 'network-first');
  assert.deepEqual(slugMatch.params, { slug: 'blue-shirt' });
});

test('URLPattern routing: supports pre-instantiated URLPattern or pattern object', () => {
  const routes = [
    { pattern: new URLPattern({ pathname: '/articles/:slug' }), strategy: 'stale-while-revalidate' },
    { match: { pathname: '/search', search: 'q=:query' }, strategy: 'network-only' },
  ];

  const match1 = matchRoute(new URL('http://localhost/articles/breaking-news'), routes);
  assert.ok(match1);
  assert.equal(match1.strategy, 'stale-while-revalidate');
  assert.deepEqual(match1.params, { slug: 'breaking-news' });

  const match2 = matchRoute(new URL('http://localhost/search?q=service-workers'), routes);
  assert.ok(match2);
  assert.equal(match2.strategy, 'network-only');
  assert.deepEqual(match2.params, { query: 'service-workers' });
});

test('URLPattern routing: cross-origin matching with origin property and full URLs', () => {
  fakeSelf('https://my-app.com');
  const routes = [
    { match: 'https://cdn.example.com/libs/*', strategy: 'cache-first' },
    { match: '/assets/*', origin: 'https://images.example.com', strategy: 'cache-first' },
    { match: '/public/*', origin: '*', strategy: 'network-first' },
    { match: '/local/*', strategy: 'network-only' },
  ];

  // Full URL match
  const cdnMatch = matchRoute(new URL('https://cdn.example.com/libs/react.js'), routes);
  assert.ok(cdnMatch);
  assert.equal(cdnMatch.strategy, 'cache-first');

  // Origin property
  const imgMatch = matchRoute(new URL('https://images.example.com/assets/hero.jpg'), routes);
  assert.ok(imgMatch);
  assert.equal(imgMatch.strategy, 'cache-first');

  // Wildcard origin
  const wildcardMatch = matchRoute(new URL('https://any-domain.org/public/data.json'), routes);
  assert.ok(wildcardMatch);
  assert.equal(wildcardMatch.strategy, 'network-first');

  // Same-origin route does not match cross-origin
  const evilMatch = matchRoute(new URL('https://evil.com/local/secret'), routes);
  assert.equal(evilMatch, null);
});

test('URLPattern routing: subpath base prefix handles app-relative routes and extracts params', () => {
  const config = {
    base: '/portal/',
    routes: [
      { match: '/users/:userId/documents/:docId', strategy: 'network-first' },
    ],
  };

  const reqUrl = new URL('https://example.com/portal/users/alice/documents/report-2026');
  const match = matchRoute(reqUrl, config.routes, config);
  assert.ok(match);
  assert.equal(match.strategy, 'network-first');
  assert.deepEqual(match.params, { userId: 'alice', docId: 'report-2026' });
});

test('resolveStrategy: attaches route and extracted params to handler and exposes to strategy context', async () => {
  fakeSelf('https://example.com');
  let capturedOptions = null;

  setupEnv(async () => new Response('data'), {
    version: '1.0.0',
    routes: [
      {
        match: '/orders/:orderId',
        strategy: 'network-first',
        plugins: [
          {
            requestWillFetch({ options }) {
              capturedOptions = options;
            },
          },
        ],
      },
    ],
  });

  const request = req('https://example.com/orders/ord-9876');
  const handler = resolveStrategy(request);

  assert.equal(handler.strategy, 'network-first');
  assert.deepEqual(handler.params, { orderId: 'ord-9876' });
  assert.ok(handler.route);

  const event = fakeEvent();
  const res = await handler(request, event);
  assert.equal(res.status, 200);

  assert.ok(capturedOptions);
  assert.deepEqual(capturedOptions.params, { orderId: 'ord-9876' });
});

test('isManifestFile: precache matches wildcard URLPattern patterns', () => {
  const config = {
    version: '1.0.0',
    configPath: '/api/update/config.json',
    precache: ['/index.html', '/assets/*', '/fonts/*.woff2'],
  };

  assert.equal(isManifestFile(new URL('https://example.com/index.html'), config), true);
  assert.equal(isManifestFile(new URL('https://example.com/assets/bundle.js'), config), true);
  assert.equal(isManifestFile(new URL('https://example.com/fonts/inter.woff2'), config), true);
  assert.equal(isManifestFile(new URL('https://example.com/other/file.txt'), config), false);
});

test('config schema: validateConfig permits pattern objects and named params in route definitions', () => {
  const config = {
    version: '1.0.0',
    verifyHashes: 'warn',
    defaultStrategy: 'network-first',
    updateAPI: { version: '/api/version', info: '/api/info' },
    caches: { offline: 'off', runtime: 'run' },
    precache: [],
    routes: [
      { match: '/api/:version/*', strategy: 'network-only' },
      { pattern: new URLPattern({ pathname: '/users/:id' }), strategy: 'cache-first' },
      { match: { pathname: '/search', search: 'q=:query' }, strategy: 'network-first' },
    ],
  };

  const errors = validateConfig(config);
  assert.deepEqual(errors, []);
});
