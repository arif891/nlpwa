import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { commitStaged } from '../src/sw/update/commit.js';
import { getActive, getStaged, resetStoreMemo } from '../src/sw/cache/store.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

function setMockNavigator(props) {
  Object.defineProperty(globalThis, 'navigator', {
    value: props,
    configurable: true,
    writable: true,
  });
}

const cfg = (extra = {}) =>
  JSON.stringify({
    routes: [{ match: '**', strategy: 'network-first' }],
    precache: ['/app.js'],
    ...extra,
  });

test('staging budget: respectSaveData defers staging when saveData is active', async () => {
  setMockNavigator({ connection: { saveData: true } });

  const v1Files = {
    '/api/update/config.json': cfg({ respectSaveData: true }),
    '/app.js': 'app v1',
  };
  const v2Files = {
    '/api/update/config.json': cfg({ respectSaveData: true }),
    '/app.js': 'app v2 updated',
  };

  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  resetStoreMemo();

  await precacheFiles();
  await commitStaged();

  server.set('1.0.1', v2Files);

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.deferred, true);
  assert.equal(res.reason, 'save-data');

  const deferredMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_DEFERRED);
  assert.ok(deferredMsg, 'Should broadcast UPDATE_DEFERRED');
  assert.equal(deferredMsg.reason, 'save-data');

  // Verify disabling saveData allows staging to proceed
  setMockNavigator({ connection: { saveData: false } });
  const res2 = await checkForUpdate();
  assert.equal(res2.updated, true);
  assert.equal(res2.staged, true);
});

test('staging budget: maxUpdateBytes rejects update when delta exceeds budget', async () => {
  setMockNavigator({ connection: { saveData: false } });

  const v1Files = {
    '/api/update/config.json': cfg({ maxUpdateBytes: 5 }),
    '/app.js': 'v1',
  };
  const v2Files = {
    '/api/update/config.json': cfg({ maxUpdateBytes: 5 }),
    '/app.js': 'large updated content that is way more than five bytes',
  };

  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  resetStoreMemo();

  await precacheFiles();
  await commitStaged();

  server.set('1.0.1', v2Files);

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.errorCode, 'BUDGET_EXCEEDED');

  const failedMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_FAILED && m.errorCode === 'BUDGET_EXCEEDED');
  assert.ok(failedMsg, 'Should broadcast UPDATE_FAILED with BUDGET_EXCEEDED');
  assert.ok(failedMsg.estimatedDeltaBytes > 5);
});

test('staging budget: wifiOnlyThresholdBytes defers staging on cellular connection', async () => {
  setMockNavigator({ connection: { type: 'cellular' } });

  const v1Files = {
    '/api/update/config.json': cfg({ wifiOnlyThresholdBytes: 10 }),
    '/app.js': 'v1',
  };
  const v2Files = {
    '/api/update/config.json': cfg({ wifiOnlyThresholdBytes: 10 }),
    '/app.js': 'cellular delta exceeds ten bytes',
  };

  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();
  setupEnv(server.fetch);
  resetStoreMemo();

  await precacheFiles();
  await commitStaged();

  server.set('1.0.1', v2Files);

  const res = await checkForUpdate();
  assert.equal(res.updated, false);
  assert.equal(res.deferred, true);
  assert.equal(res.reason, 'wifi-only');

  const deferredMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_DEFERRED && m.reason === 'wifi-only');
  assert.ok(deferredMsg, 'Should broadcast UPDATE_DEFERRED with wifi-only');
});

test('staging resumption: previously downloaded files are reused on retry without re-fetching', async () => {
  setMockNavigator({ connection: { saveData: false } });

  let fetchCalls = [];
  const v1Files = {
    '/api/update/config.json': cfg({ precache: ['/app.js', '/extra.js'] }),
    '/app.js': 'app v1',
    '/extra.js': 'extra v1',
  };
  const v2Files = {
    '/api/update/config.json': cfg({ precache: ['/app.js', '/extra.js'] }),
    '/app.js': 'app v2 updated',
    '/extra.js': 'extra v2 updated',
  };

  let failExtra = false;
  const server = makeServer('1.0.0', v1Files);
  const originalFetch = server.fetch;
  const wrappedFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    fetchCalls.push(url);
    if (url.includes('/extra.js') && failExtra) {
      return new Response('Server Error', { status: 500 });
    }
    return originalFetch(input, init);
  };

  const messages = fakeSelf();
  setupEnv(wrappedFetch);
  resetStoreMemo();

  await precacheFiles();
  await commitStaged();

  server.set('1.0.1', v2Files);

  // Attempt 1: extra.js fails with 500, app.js succeeds
  failExtra = true;
  fetchCalls = [];
  const res1 = await checkForUpdate();
  assert.equal(res1.updated, false);
  assert.equal(res1.errorCode, 'DOWNLOAD_FAILED');
  assert.ok(fetchCalls.some((u) => u.includes('/app.js')), 'Should have fetched app.js on attempt 1');

  // Verify staged cache exists and has app.js stored
  const staged = await getStaged();
  assert.ok(staged, 'Staged record exists');
  assert.equal(staged.complete, false);

  // Attempt 2: extra.js succeeds now
  failExtra = false;
  fetchCalls = [];
  const res2 = await checkForUpdate();
  assert.equal(res2.updated, true);
  assert.equal(res2.staged, true);

  // app.js was already in the staging cache, so it should NOT have been fetched from the server again!
  const appFetchedAgain = fetchCalls.filter((u) => u.includes('/app.js') && !u.includes('config.json'));
  assert.equal(appFetchedAgain.length, 0, 'app.js should not be refetched on resumed staging');
  const extraFetched = fetchCalls.filter((u) => u.includes('/extra.js'));
  assert.equal(extraFetched.length, 1, 'extra.js should be fetched on attempt 2');
});
