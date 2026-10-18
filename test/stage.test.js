import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, hash8 } from './helpers/fake-server.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { commitStaged } from '../src/sw/update/commit.js';
import { loadCachedSnapshot, fetchServerManifest } from '../src/sw/update/manifest.js';
import { getActive, getStaged } from '../src/sw/cache/store.js';
import { MAX_RETRY_ATTEMPTS } from '../src/shared/constants.js';

const CONFIG = JSON.stringify({ routes: [{ match: '**', strategy: 'network-first' }], precache: ['/app.js'] });
const v1 = { '/config.json': CONFIG, '/app.js': 'app v1', '/style.css': 'css v1' };

async function stageAndCommit(server, opts) {
  const result = await stageUpdate(await fetchServerManifest(), opts);
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
  const result = await stageUpdate(await fetchServerManifest(), { activeSnapshot: await loadCachedSnapshot() });
  assert.equal(result.status, 'ready');

  // running app still sees v1 everywhere
  assert.equal((await getActive()).cache, activeV1);
  assert.equal((await loadCachedSnapshot()).version, '1.0.0');
  assert.equal(await (await (await caches.open(activeV1)).match(req('/app.js'))).text(), 'app v1');

  // commit flips everything together and removes the old cache
  assert.equal(await commitStaged(), true);
  const active = await getActive();
  assert.equal(active.version, '1.0.1');
  assert.equal(await (await (await caches.open(active.cache)).match(req('/app.js'))).text(), 'app v2');
  assert.equal(await getStaged(), null);
  assert.equal((await caches.keys()).includes(activeV1), false, 'old cache removed');
});

test('stage: unchanged files are copied locally, only changed files hit the network', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  await stageAndCommit(server);

  server.calls.length = 0;
  server.set('1.0.1', { ...v1, '/app.js': 'app v2' });
  const result = await stageUpdate(await fetchServerManifest(), { activeSnapshot: await loadCachedSnapshot() });
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
  setupEnv(server.fetch);
  server.lie.set('/app.js', hash8('something else'));

  const result = await stageUpdate(await fetchServerManifest());
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
  });
  const result = await stageUpdate(await fetchServerManifest());
  assert.deepEqual(result.failed, ['/app.js']);
});

test("verify 'warn' stores the mismatching file anyway; false skips verification", async () => {
  for (const mode of ['warn', false]) {
    const server = makeServer('1.0.0', v1);
    setupEnv(server.fetch, { verifyHashes: mode });
    server.lie.set('/app.js', hash8('something else'));
    const result = await stageUpdate(await fetchServerManifest());
    assert.equal(result.status, 'ready', `mode ${mode}`);
  }
});

test('resume: a retry reuses files that already verified instead of downloading them again', async () => {
  const server = makeServer('1.0.0', v1);
  setupEnv(server.fetch);
  server.broken.add('/style.css');

  const first = await stageUpdate(await fetchServerManifest());
  assert.equal(first.status, 'incomplete');
  assert.equal(first.retryCount, 1);

  server.broken.clear();
  server.calls.length = 0;
  const second = await stageUpdate(await fetchServerManifest());
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
    result = await stageUpdate(await fetchServerManifest(), { activeSnapshot: await loadCachedSnapshot() });
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
  const recovered = await stageUpdate(await fetchServerManifest(), { activeSnapshot: await loadCachedSnapshot() });
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.partial, false);
  assert.equal(await commitStaged(), true);

  const finalSnap = await loadCachedSnapshot();
  assert.equal(finalSnap.version, '1.0.1');
  assert.equal(finalSnap.files.find((f) => f.path === '/app.js').hash, hash8('app v2'));
});

test('a new version discards an older partial staging cache', async () => {
  const server = makeServer('1.0.0', v1);
  const caches = setupEnv(server.fetch);
  server.broken.add('/style.css');
  await stageUpdate(await fetchServerManifest());
  const stale = (await getStaged()).cache;

  server.broken.clear();
  server.set('1.0.1', v1);
  await stageUpdate(await fetchServerManifest());
  assert.equal((await caches.keys()).includes(stale), false);
});
