import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, hash8 } from './helpers/fake-server.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { commitStaged } from '../src/sw/update/commit.js';
import { loadCachedSnapshot, fetchServerInfo } from '../src/sw/update/manifest.js';
import { getActive, getStaged } from '../src/sw/cache/store.js';
import { MAX_RETRY_ATTEMPTS } from '../src/shared/constants.js';

const CONFIG = JSON.stringify({ routes: [{ match: '**', strategy: 'network-first' }], precache: ['/app.js'] });
const v1 = { '/config.json': CONFIG, '/app.js': 'app v1', '/style.css': 'css v1' };

async function stageAndCommit(server, opts) {
  const result = await stageUpdate(await fetchServerInfo(), opts);
  assert.equal(result.status, 'ready');
  assert.equal(await commitStaged(), true);
  return result;
}

test('stage: builds a separate cache and leaves the active version untouched until commit', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await stageAndCommit(server);
  const activeV1 = (await getActive()).cache;

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  const result = await stageUpdate(await fetchServerInfo(), { activeSnapshot: await loadCachedSnapshot() });
  assert.equal(result.status, 'ready');

  // running app still sees v1 everywhere
  assert.equal((await getActive()).cache, activeV1);
  assert.equal((await loadCachedSnapshot()).version, '1.0.0');
  assert.equal(await (await (await caches.open(activeV1)).match(req('/app.js'))).text(), 'app v1');

  // commit flips everything together and retains the previous cache for open tabs
  assert.equal(await commitStaged(), true);
  const active = await getActive();
  assert.equal(active.version, '1.0.1');
  assert.equal(await (await (await caches.open(active.cache)).match(req('/app.js'))).text(), 'app v2');
  assert.equal(await getStaged(), null);
  assert.equal((await caches.keys()).includes(activeV1), true, 'immediate previous cache retained for open tabs');

  // A subsequent version commit evicts activeV1
  server.set('1.0.2', { ...v1, '/app.js': 'app v3' });
  await stageUpdate(await fetchServerInfo(), { activeSnapshot: await loadCachedSnapshot() });
  await commitStaged();
  assert.equal((await caches.keys()).includes(activeV1), false, 'oldest cache removed after subsequent commit');
});

test('stage: unchanged files are copied locally, only changed files hit the network', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  await stageAndCommit(server);

  server.calls.length = 0;
  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  const result = await stageUpdate(await fetchServerInfo(), { activeSnapshot: await loadCachedSnapshot() });
  assert.deepEqual(server.fileCalls(), ['/app.js']);
  assert.equal(result.copied, 2);
  assert.equal(result.fetched, 1);
});

test('stage: forceRefetch downloads everything and clears the runtime cache on commit', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await stageAndCommit(server);
  await (await caches.open('runtime')).put(req('/lazy.png'), new Response('img'));

  server.calls.length = 0;
  await stageAndCommit(server, { activeSnapshot: await loadCachedSnapshot(), forceRefetch: true });
  assert.equal(server.fileCalls().length, 3);
  assert.equal(await (await caches.open('runtime')).match(req('/lazy.png')), undefined);
});

test('stage: commit evicts only modified/removed entries from the runtime cache', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  await stageAndCommit(server);
  const runtime = await caches.open('runtime');
  await runtime.put(req('/app.js'), new Response('stale'));
  await runtime.put(req('/lazy.png'), new Response('img'));

  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  await stageAndCommit(server, { activeSnapshot: await loadCachedSnapshot() });
  assert.equal(await runtime.match(req('/app.js')), undefined);
  assert.ok(await runtime.match(req('/lazy.png')), 'lazily cached files survive');
});

test('verify strict: a body that does not match its manifest hash is rejected, nothing goes live', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch, { verifyHashes: 'strict' });
  server.lie.set('/app.js', hash8('something else'));

  const result = await stageUpdate(await fetchServerInfo());
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.failed, ['/app.js']);
  assert.equal(await commitStaged(), false, 'incomplete staging cannot be committed');
  assert.equal(await getActive(), null);
});

test('verify strict: a host that answers 200 with HTML for a missing file is caught', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(async (r) => {
    const path = new URL(r.url).pathname;
    if (path === '/app.js') return new Response('<html>SPA fallback</html>'); // 200, wrong body
    return server.fetch(r);
  }, { verifyHashes: 'strict' });
  const result = await stageUpdate(await fetchServerInfo());
  assert.deepEqual(result.failed, ['/app.js']);
});

test("verify 'warn' stores the mismatching file anyway; false skips verification", async () => {
  for (const mode of ['warn', false]) {
    const server = makeServer('1.0.0', v1);
    setupEnv(server.fetch, { verifyHashes: mode });
    server.lie.set('/app.js', hash8('something else'));
    const result = await stageUpdate(await fetchServerInfo());
    assert.equal(result.status, 'ready', `mode ${mode}`);
  }
});

test('resume: a retry reuses files that already verified instead of downloading them again', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  server.broken.add('/style.css');

  const first = await stageUpdate(await fetchServerInfo());
  assert.equal(first.status, 'incomplete');
  assert.equal(first.retryCount, 1);

  server.broken.clear();
  server.calls.length = 0;
  const second = await stageUpdate(await fetchServerInfo());
  assert.equal(second.status, 'ready');
  assert.deepEqual(server.fileCalls(), ['/style.css']);
  assert.equal(second.reused, 2);
});

test('strict atomic staging: after MAX_RETRY_ATTEMPTS the update remains incomplete, active version untouched', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  await stageAndCommit(server);

  server.set('1.0.1', { ...v1, '/app.js': 'app v2', '/new.js': 'new' });
  server.broken.add('/app.js');
  server.broken.add('/new.js');

  let result;
  for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
    result = await stageUpdate(await fetchServerInfo(), { activeSnapshot: await loadCachedSnapshot() });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.failed.sort(), ['/app.js', '/new.js']);
  }
  // Even after MAX_RETRY_ATTEMPTS, it never finalizes or commits incomplete updates
  assert.equal(result.status, 'incomplete');
  assert.equal(await commitStaged(), false, 'incomplete staging cannot be committed');

  const snap = await loadCachedSnapshot();
  assert.equal(snap.version, '1.0.0', 'active version remains clean and uncorrupted');
  assert.equal(snap.files.find((f) => f.path === '/app.js').hash, hash8('app v1'));
  assert.equal(snap.files.some((f) => f.path === '/new.js'), false);

  // When network recovers, next stage completes cleanly
  server.broken.clear();
  const recovered = await stageUpdate(await fetchServerInfo(), { activeSnapshot: await loadCachedSnapshot() });
  assert.equal(recovered.status, 'ready');
  assert.equal(await commitStaged(), true);

  const finalSnap = await loadCachedSnapshot();
  assert.equal(finalSnap.version, '1.0.1');
  assert.equal(finalSnap.files.find((f) => f.path === '/app.js').hash, hash8('app v2'));
});

test('a new version discards an older partial staging cache', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  server.broken.add('/style.css');
  await stageUpdate(await fetchServerInfo());
  const stale = (await getStaged()).cache;

  server.broken.clear();
  server.set('1.0.1', v1);
  await stageUpdate(await fetchServerInfo());
  assert.equal((await caches.keys()).includes(stale), false);
});

test('stage: skips in-memory hash verification for files exceeding maxVerifyBytes threshold by default without failing', async () => {
  const server = makeServer('1.0.0', {
    ...v1,
    '/model.wasm': 'wasm-binary-bytes-data',
  });
  // maxVerifyBytes configured to 10 bytes, while model.wasm is > 10 bytes.
  // allowOversizedUnverified defaults to true, so it stores with a warning instead of failing
  setupEnv(server.fetch, { maxVerifyBytes: 10 });
  server.lie.set('/model.wasm', hash8('tampered-or-different'));

  const result = await stageUpdate(await fetchServerInfo());
  assert.equal(result.status, 'ready');
  assert.equal(result.failed.length, 0);
  assert.equal(await commitStaged(), true);
});

test('stage: strict mode enforces hash verification on oversized files when allowOversizedUnverified is explicitly false', async () => {
  const server = makeServer('1.0.0', {
    ...v1,
    '/model.wasm': 'wasm-binary-bytes-data',
  });
  // Explicit opt-out requires strict failure on oversized files
  setupEnv(server.fetch, { verifyHashes: 'strict', maxVerifyBytes: 10, allowOversizedUnverified: false });
  server.lie.set('/model.wasm', hash8('tampered-or-different'));

  const result = await stageUpdate(await fetchServerInfo());
  assert.equal(result.status, 'incomplete');
  assert.ok(result.failed.includes('/model.wasm'));
});

test('stage: skips in-memory hash verification when file is annotated with skipVerify in manifest', async () => {
  const server = makeServer('1.0.0', {
    ...v1,
    '/model.wasm': 'wasm-binary-bytes-data',
  });
  setupEnv(server.fetch, { allowOversizedUnverified: false }); // even if allowOversizedUnverified is false
  const manifest = await fetchServerInfo();
  // Annotate /model.wasm with skipVerify: true as produced by the CLI
  const wasmEntry = manifest.files.find((f) => f.path === '/model.wasm');
  if (wasmEntry) wasmEntry.skipVerify = true;
  server.lie.set('/model.wasm', hash8('tampered-or-different'));

  const result = await stageUpdate(manifest);
  assert.equal(result.status, 'ready');
  assert.equal(result.failed.length, 0);
  assert.equal(await commitStaged(), true);
});

test('stage: recovers from QuotaExceededError by triggering cleanRuntimeCache and retrying', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);

  // Put an entry into runtime cache
  const runtime = await caches.open('runtime');
  await runtime.put(req('/cached-video.mp4'), new Response('lots of bytes', {
    headers: { 'Content-Length': '1000000', 'X-NLPWA-Cached-At': String(Date.now() - 5000) },
  }));

  let quotaThrown = false;
  // Intercept open to hook cache.put on staging cache
  const origOpen = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await origOpen(name);
    if (name.startsWith('offline@')) {
      const origPut = cache.put.bind(cache);
      cache.put = async (path, res) => {
        const urlStr = typeof path === 'string' ? path : path.url;
        if (!quotaThrown && urlStr.includes('/app.js')) {
          quotaThrown = true;
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        }
        return origPut(path, res);
      };
    }
    return cache;
  };

  const result = await stageUpdate(await fetchServerInfo());
  assert.equal(quotaThrown, true, 'QuotaExceededError was triggered');
  assert.equal(result.status, 'ready', 'Staging succeeded after cleanRuntimeCache reclaimed space');
  assert.equal(await runtime.match(req('/cached-video.mp4')), undefined, 'Runtime cache was evicted');
});

test('stage: persistent QuotaExceededError reports quotaExceeded: true', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);

  // Intercept open to hook cache.put on staging cache to always throw QuotaExceededError
  const origOpen = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await origOpen(name);
    if (name.startsWith('offline@')) {
      cache.put = async (path) => {
        const urlStr = typeof path === 'string' ? path : path.url;
        if (urlStr.includes('/app.js')) {
          const err = new Error('Quota exceeded on disk.');
          err.name = 'QuotaExceededError';
          throw err;
        }
      };
    }
    return cache;
  };

  const result = await stageUpdate(await fetchServerInfo());
  assert.equal(result.status, 'incomplete');
  assert.equal(result.quotaExceeded, true);
  assert.ok(result.failed.includes('/app.js'));
});
