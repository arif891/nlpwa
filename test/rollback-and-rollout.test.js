import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, req } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { commitStaged, commitIfReady, rollbackToFallback } from '../src/sw/update/commit.js';
import { getConfig } from '../src/sw/config/index.js';
import {
  getActive,
  getStaged,
  blockVersion,
  isVersionBlocked,
  unblockVersion,
  syncBlockedVersions,
  getBlockedVersions,
  writeMeta,
  resetStoreMemo,
} from '../src/sw/cache/store.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

const cfg = (extra = {}) =>
  JSON.stringify({
    routes: [{ match: '**', strategy: 'network-first' }],
    precache: ['/app.js'],
    ...extra,
  });

const v1Files = {
  '/api/update/config.json': cfg(),
  '/app.js': 'app v1 content',
};

const v2Files = {
  '/api/update/config.json': cfg(),
  '/app.js': 'app v2 updated content',
};

test('blocked versions store: add, query, unblock, and remote sync', async () => {
  setupEnv(() => new Response(''));
  resetStoreMemo();

  assert.equal(await isVersionBlocked('1.0.0'), false);

  await blockVersion('1.0.0', 'Known crash bug');
  assert.equal(await isVersionBlocked('1.0.0'), true);
  assert.deepEqual(await getBlockedVersions(), ['1.0.0']);

  await syncBlockedVersions(['1.0.0', '1.0.1', '2.0.0-beta']);
  assert.equal(await isVersionBlocked('1.0.1'), true);
  assert.equal(await isVersionBlocked('2.0.0-beta'), true);

  await unblockVersion('1.0.0');
  assert.equal(await isVersionBlocked('1.0.0'), false);
  assert.equal(await isVersionBlocked('1.0.1'), true);
});

test('rollback: commit retains fallbackCache, and rollbackToFallback reverts to previous stable cache', async () => {
  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();
  setupEnv(server.fetch);

  // Install v1.0.0
  await precacheFiles();
  const active1 = await getActive();
  assert.equal(active1.version, '1.0.0');
  const v1CacheName = active1.cache;

  // Stage v2.0.0
  server.set('2.0.0', v2Files);
  const checkResult = await checkForUpdate();
  assert.equal(checkResult.updated, true);

  // Commit v2.0.0
  const committed = await commitStaged();
  assert.equal(committed, true);

  const active2 = await getActive();
  assert.equal(active2.version, '2.0.0');
  assert.equal(active2.fallbackCache, v1CacheName);
  assert.equal(active2.fallbackVersion, '1.0.0');

  // Verify fallback cache was NOT deleted
  const cacheNames = await caches.keys();
  assert.ok(cacheNames.includes(v1CacheName), 'fallback cache is preserved on disk');

  messages.length = 0;

  // Execute rollback
  const rollbackResult = await rollbackToFallback('Syntax error in v2');
  assert.equal(rollbackResult.success, true);
  assert.equal(rollbackResult.version, '1.0.0');
  assert.equal(rollbackResult.rolledBackFrom, '2.0.0');

  // Active should now be v1.0.0 again
  const restored = await getActive();
  assert.equal(restored.version, '1.0.0');
  assert.equal(restored.cache, v1CacheName);

  // v2.0.0 should now be blacklisted
  assert.equal(await isVersionBlocked('2.0.0'), true);

  // Broadcast ROLLBACK_APPLIED should be delivered to clients
  const rollbackMsg = messages.find((m) => m.type === MESSAGE_TYPES.ROLLBACK_APPLIED);
  assert.ok(rollbackMsg);
  assert.equal(rollbackMsg.version, '1.0.0');
  assert.equal(rollbackMsg.rolledBackFrom, '2.0.0');
});

test('kill-switch: update check detects active version is in remote blockedVersions and rolls back', async () => {
  const server = makeServer('1.0.0', v1Files);
  const messages = fakeSelf();
  setupEnv(server.fetch);

  // Install v1.0.0
  await precacheFiles();

  // Update to v2.0.0
  server.set('2.0.0', v2Files);
  await checkForUpdate();
  await commitStaged();
  assert.equal((await getActive()).version, '2.0.0');

  // Server revokes v2.0.0 via remote kill-switch
  server.blockedVersions = ['2.0.0'];
  messages.length = 0;

  const result = await checkForUpdate();
  assert.equal(result.rolledBack, true);
  assert.equal(result.version, '1.0.0');

  // Active pointer is reverted to 1.0.0
  assert.equal((await getActive()).version, '1.0.0');
});

test('kill-switch: update check skips staging if remote target version is blocked', async () => {
  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch);

  await precacheFiles();
  assert.equal((await getActive()).version, '1.0.0');

  // Server offers v2.0.0 but it is in blockedVersions
  server.set('2.0.0', v2Files);
  server.blockedVersions = ['2.0.0'];

  const result = await checkForUpdate();
  assert.equal(result.updated, false);
  assert.equal(result.blocked, true);
  assert.equal(result.version, '2.0.0');
  assert.equal(await getStaged(), null, 'staged update is discarded/skipped');
});

test('rollout: rolloutPercent excludes clients not in cohort unless forced', async () => {
  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch);

  await precacheFiles();

  // Set client seed to 50
  await writeMeta('/_nlpwa/rollout-seed.json', { seed: 50 });

  // Offer v2.0.0 with 25% rollout
  server.set('2.0.0', v2Files);
  server.rolloutPercent = 25;

  const resultExcluded = await checkForUpdate();
  assert.equal(resultExcluded.updated, false);
  assert.equal(resultExcluded.rolloutExcluded, true);

  // When force is true, rollout gate is bypassed
  const resultForced = await checkForUpdate({ force: true });
  assert.equal(resultForced.updated, true);
  assert.equal(resultForced.version, '2.0.0');
});

test('channel: update check filters by release channel', async () => {
  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch, { channel: 'stable' });

  await precacheFiles();

  // Server publishes beta channel release
  server.set('2.0.0-beta', v2Files);
  server.channel = 'beta';

  const result = await checkForUpdate();
  assert.equal(result.updated, false);
  assert.equal(result.channelMismatch, true);
});

test('probation: 2 consecutive failures trigger rollback; single failure does not', async () => {
  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch);

  await precacheFiles();
  server.set('2.0.0', v2Files);
  await checkForUpdate();
  await commitIfReady();

  const { readMeta } = await import('../src/sw/cache/store.js');
  let probation = await readMeta('/_nlpwa/probation.json');
  assert.equal(probation.status, 'probation');
  assert.equal(probation.version, '2.0.0');
  assert.equal(probation.healthyBoots, 0);
  assert.equal(probation.consecutiveFailures, 0);

  const { handleMessage } = await import('../src/sw/events/message.js');
  const onMsg = handleMessage(getConfig());

  // Failure #1
  let reply1;
  let waitP1;
  const ev1 = {
    data: { type: MESSAGE_TYPES.REPORT_BOOT_FAILURE, error: 'First glitch' },
    waitUntil(p) { waitP1 = p; },
    source: { postMessage(p) { reply1 = p; } },
  };
  onMsg(ev1);
  await waitP1;

  assert.equal(reply1.data.rolledBack, false, 'single failure does not trigger rollback');
  assert.equal((await getActive()).version, '2.0.0');
  probation = await readMeta('/_nlpwa/probation.json');
  assert.equal(probation.consecutiveFailures, 1);

  // Failure #2 -> reaches failureThreshold (2) -> triggers rollback
  let reply2;
  let waitP2;
  const ev2 = {
    data: { type: MESSAGE_TYPES.REPORT_BOOT_FAILURE, error: 'Second glitch' },
    waitUntil(p) { waitP2 = p; },
    source: { postMessage(p) { reply2 = p; } },
  };
  onMsg(ev2);
  await waitP2;

  assert.equal(reply2.data.rolledBack, true, 'second consecutive failure triggers rollback');
  assert.equal((await getActive()).version, '1.0.0', 'reverted to fallback version');
});

test('probation: 2 consecutive healthy boots promote version to stable', async () => {
  const server = makeServer('1.0.0', v1Files);
  fakeSelf();
  setupEnv(server.fetch);

  await precacheFiles();
  server.set('2.0.0', v2Files);
  await checkForUpdate();
  await commitIfReady();

  const { readMeta } = await import('../src/sw/cache/store.js');
  const { handleMessage } = await import('../src/sw/events/message.js');
  const onMsg = handleMessage(getConfig());

  // Healthy boot 1
  let reply1;
  let waitP1;
  onMsg({
    data: { type: MESSAGE_TYPES.REPORT_BOOT_HEALTH },
    waitUntil(p) { waitP1 = p; },
    source: { postMessage(p) { reply1 = p; } },
  });
  await waitP1;
  let probation = await readMeta('/_nlpwa/probation.json');
  assert.equal(probation.healthyBoots, 1);
  assert.equal(probation.status, 'probation');

  // Healthy boot 2 -> stable
  let reply2;
  let waitP2;
  onMsg({
    data: { type: MESSAGE_TYPES.REPORT_BOOT_HEALTH },
    waitUntil(p) { waitP2 = p; },
    source: { postMessage(p) { reply2 = p; } },
  });
  await waitP2;
  probation = await readMeta('/_nlpwa/probation.json');
  assert.equal(probation.healthyBoots, 2);
  assert.equal(probation.status, 'stable');
});

test('blocked versions: client block expires after TTL', async () => {
  setupEnv(() => new Response(''));
  resetStoreMemo();

  await blockVersion('9.9.9', 'Temporary ban', { ttlMs: 30 });
  assert.equal(await isVersionBlocked('9.9.9'), true);

  await new Promise((r) => setTimeout(r, 45));
  assert.equal(await isVersionBlocked('9.9.9'), false, 'block expired after TTL');
});
