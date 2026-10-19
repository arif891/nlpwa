import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { stageUpdate } from '../src/sw/update/stage.js';
import { fetchServerInfo } from '../src/sw/update/manifest.js';
import { commitStaged, sweepOrphanCaches } from '../src/sw/update/commit.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { getFromOffline } from '../src/sw/cache/offline/store.js';
import {
  getActive,
  setActive,
  getStaged,
  setStaged,
  clearStaged,
  resetStoreMemo,
} from '../src/sw/cache/store.js';

const cfg = (extra = {}) => JSON.stringify({
  routes: [{ match: '**', strategy: 'cache-first' }],
  precache: ['/app.js', '/config.json', '/index.html'],
  ...extra,
});

test('crash resilience: SW killed mid-stage leaves active version uncorrupted and never commits partial cache', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1 content',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const activeV1 = await getActive();
  assert.equal(activeV1.version, '1.0.0');

  // Verify active version serves content
  const res1 = await getFromOffline('/app.js');
  assert.equal(await res1.text(), 'app v1 content');

  // Server publishes v2
  server.set('2.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v2 content',
    '/index.html': '<html>v2</html>',
  });

  // SIMULATE: SW begins staging v2, opens staging cache, but crashes mid-flight before completing
  const partialStagingCache = 'offline@2.0.0-partial-stage';
  const c = await caches.open(partialStagingCache);
  await c.put('/app.js', new Response('app v2 content'));
  // Worker recorded staged pointer with complete: false (or didn't record complete: true)
  await setStaged({
    cache: partialStagingCache,
    version: '2.0.0',
    swVersion: '1',
    complete: false,
  });

  // SIMULATE: Browser restarts SW process
  resetStoreMemo();

  // Navigation arrives and tries to commit
  const committed = await commitStaged();
  assert.equal(committed, false, 'Must reject incomplete staged update');

  // Active version MUST remain v1 without any corrupted or mixed files
  const activeAfterCrash = await getActive();
  assert.equal(activeAfterCrash.version, '1.0.0');
  const resAfterCrash = await getFromOffline('/app.js');
  assert.equal(await resAfterCrash.text(), 'app v1 content', 'Active cache must continue serving v1 cleanly');

  // Check for update recovers cleanly: resumes/completes v2 staging
  const updateResult = await checkForUpdate({ force: true });
  assert.equal(updateResult.updated, true);
  assert.equal(updateResult.version, '2.0.0');

  const stagedNow = await getStaged();
  assert.equal(stagedNow.complete, true);

  // Now committing completes atomic transition to v2
  const committedAfterRecovery = await commitStaged();
  assert.equal(committedAfterRecovery, true);
  const activeCommitted = await getActive();
  assert.equal(activeCommitted.version, '2.0.0');
});

test('crash resilience: SW killed mid-commit immediately before setActive leaves previous version live', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const activeV1 = await getActive();
  assert.equal(activeV1.version, '1.0.0');

  // Stage v2 completely
  server.set('2.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v2',
    '/index.html': '<html>v2</html>',
  });
  await stageUpdate(await fetchServerInfo());

  const stagedV2 = await getStaged();
  assert.equal(stagedV2.complete, true);

  // SIMULATE: Worker process killed BEFORE setActive() executed
  resetStoreMemo();

  // Active version in meta store is still v1
  const activeNow = await getActive();
  assert.equal(activeNow.version, '1.0.0');
  assert.equal(activeNow.cache, activeV1.cache);

  const res = await getFromOffline('/app.js');
  assert.equal(await res.text(), 'app v1', 'App serves v1 fully intact without corruption');

  // On next navigation/retry, commitStaged succeeds cleanly
  const committed = await commitStaged();
  assert.equal(committed, true);

  const activeNew = await getActive();
  assert.equal(activeNew.version, '2.0.0');
  const resNew = await getFromOffline('/app.js');
  assert.equal(await resNew.text(), 'app v2');
});

test('crash resilience: SW killed mid-commit immediately after setActive recovers without error', async () => {
  const server = makeServer('1.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v1',
    '/index.html': '<html>v1</html>',
  });
  setupEnv(server.fetch);
  await precacheFiles();

  const activeV1 = await getActive();

  // Stage v2 completely
  server.set('2.0.0', {
    '/config.json': cfg(),
    '/app.js': 'app v2',
    '/index.html': '<html>v2</html>',
  });
  await stageUpdate(await fetchServerInfo());
  const stagedV2 = await getStaged();

  // SIMULATE: setActive executed, but worker killed before clearStaged() or disk cleanup
  await setActive({
    cache: stagedV2.cache,
    version: stagedV2.version,
    swVersion: stagedV2.swVersion,
  });
  // staged pointer still remains in store (worker crashed before clearStaged)
  assert.ok((await getStaged()) !== null);

  // SIMULATE: SW restarts on next navigation
  resetStoreMemo();

  // Commit guard triggers: detects staged.cache is already active.cache
  const secondCommit = await commitStaged();
  assert.equal(secondCommit, false, 'Guard must detect version is already active and not duplicate work');

  // Lingering staged pointer is cleared
  assert.equal(await getStaged(), null, 'Stale staged pointer must be cleaned up');

  // Active version is v2
  const currentActive = await getActive();
  assert.equal(currentActive.version, '2.0.0');

  // sweepOrphanCaches cleans up old v1 cache cleanly
  await sweepOrphanCaches();
  const remainingCaches = await caches.keys();
  assert.equal(remainingCaches.includes(activeV1.cache), false, 'Old v1 cache swept successfully');
});
