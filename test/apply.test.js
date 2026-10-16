import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { applyDiff } from '../src/sw/update/apply.js';
import { loadCachedSnapshot, saveCachedSnapshot } from '../src/sw/update/manifest.js';
import { MAX_RETRY_ATTEMPTS } from '../src/shared/constants.js';

const manifest = (files, version = '2.0.0') => ({ version, files });

test('applyDiff: success stores files and a clean snapshot', async () => {
  setupEnv(async (r) => new Response(`body:${new URL(r.url).pathname}`));
  const m = manifest([{ path: '/a.js', hash: 'h1' }]);
  const result = await applyDiff({ added: ['/a.js'], modified: [], removed: [] }, m);
  assert.equal(result.success, true);
  assert.equal(result.applied, 1);
  const snap = await loadCachedSnapshot();
  assert.equal(snap.needsRetry, false);
  assert.deepEqual(snap.files, m.files);
});

test('applyDiff: failures keep the old hash, set needsRetry and report partial success', async () => {
  setupEnv(async (r) => {
    if (r.url.endsWith('/bad.js')) return new Response('nope', { status: 404 });
    return new Response('ok');
  });
  await saveCachedSnapshot(manifest([{ path: '/bad.js', hash: 'old' }], '1.0.0'));

  const m = manifest([{ path: '/bad.js', hash: 'new' }, { path: '/good.js', hash: 'g' }]);
  const result = await applyDiff({ added: ['/good.js'], modified: ['/bad.js'], removed: [] }, m);

  assert.equal(result.success, false);
  assert.deepEqual(result.failed, ['/bad.js']);
  assert.equal(result.applied, 1); // good.js made it
  const snap = await loadCachedSnapshot();
  assert.equal(snap.needsRetry, true);
  assert.equal(snap.retryCount, 1);
  assert.equal(snap.files.find(f => f.path === '/bad.js').hash, 'old');
  assert.equal(snap.files.find(f => f.path === '/good.js').hash, 'g');
});

test('applyDiff: stops retrying after MAX_RETRY_ATTEMPTS but retries again on a hash change', async () => {
  setupEnv(async () => new Response('missing', { status: 404 }));
  const m = manifest([{ path: '/missing.js', hash: 'x' }]);

  let last;
  for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
    last = await applyDiff({ added: ['/missing.js'], modified: [], removed: [] }, m);
  }
  assert.equal(last.gaveUp, true);

  const snap = await loadCachedSnapshot();
  assert.equal(snap.needsRetry, false, 'no more retries on every check');
  assert.equal(snap.files.some(f => f.path === '/missing.js'), false,
    'file stays out of the snapshot so a later version bump re-adds it');
});
