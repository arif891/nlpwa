import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer, fakeSelf } from './helpers/fake-server.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import { commitStaged } from '../src/sw/update/commit.js';
import {
  getStaged,
  setStaged,
  writeMeta,
  blockVersion,
} from '../src/sw/cache/meta/index.js';

const v1Files = {
  '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
  '/app.js': 'app v1',
};

const v2Files = {
  '/api/update/config.json': JSON.stringify({ routes: [], precache: ['/app.js'] }),
  '/app.js': 'app v2',
};

const matrix = [
  {
    name: 'already-up-to-date: active == server, no staged',
    activeVersion: '1.0.0',
    serverVersion: '1.0.0',
    expected: { updated: false, rolledBack: false },
  },
  {
    name: 'already-up-to-date: active == server, discards incomplete staged delta',
    activeVersion: '1.0.0',
    serverVersion: '1.0.0',
    staged: { version: '2.0.0', cache: 'offline@2.0.0-staged', complete: false },
    expected: { updated: false, rolledBack: true, stagedAfter: null },
  },
  {
    name: 'staged-ready: complete staged matches serverVersion',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    staged: { version: '2.0.0', cache: 'offline@2.0.0-staged', complete: true, swVersion: '1' },
    expected: { updated: true, staged: true, version: '2.0.0' },
  },
  {
    name: 'retry-backoff: incomplete staged with unexpired nextRetryAt skips check',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    staged: { version: '2.0.0', cache: 'offline@2.0.0-staged', complete: false, nextRetryAt: Date.now() + 100000 },
    expected: { updated: false, backingOff: true },
  },
  {
    name: 'channel-mismatch: server release channel differs from client configured channel',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    clientChannel: 'stable',
    serverChannel: 'beta',
    expected: { updated: false, channelMismatch: true },
  },
  {
    name: 'rollout-excluded: client cohort excluded by rolloutPercent',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    seed: 2, // stringHash('2:2.0.0') % 100 = 85
    rolloutPercent: 25, // 85 >= 25 -> excluded
    expected: { updated: false, rolloutExcluded: true, rolloutPercent: 25 },
  },
  {
    name: 'rollout-included: client cohort included by rolloutPercent stages update',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    seed: 50, // stringHash('50:2.0.0') % 100 = 2
    rolloutPercent: 25, // 2 < 25 -> included
    expected: { updated: true, staged: true, version: '2.0.0' },
  },
  {
    name: 'target-blocked: Tier 1 target version is in blockedVersions',
    activeVersion: '1.0.0',
    serverVersion: '2.0.0',
    blockedVersions: ['2.0.0'],
    expected: { updated: false, blocked: true, version: '2.0.0' },
  },
  {
    name: 'kill-switch-rollback: active version in remote blocked list triggers rollback to fallback',
    activeVersion: '2.0.0',
    fallbackVersion: '1.0.0',
    serverVersion: '2.0.0',
    activeBlocked: true,
    expected: { updated: false, rolledBack: true, version: '1.0.0' },
  },
  {
    name: 'fresh-install: active is null, stages and commits initial version',
    activeVersion: null,
    serverVersion: '1.0.0',
    expected: { updated: false, initial: true, version: '1.0.0' },
  },
];

for (const sc of matrix) {
  test(`version-state-matrix: ${sc.name}`, async () => {
    const server = makeServer('1.0.0', v1Files);
    fakeSelf();
    setupEnv(server.fetch, {
      channel: sc.clientChannel || undefined,
    });

    if (sc.activeVersion) {
      // Install initial version 1.0.0
      await precacheFiles();

      if (sc.activeVersion === '2.0.0') {
        server.set('2.0.0', v2Files);
        await checkForUpdate({ force: true });
        await commitStaged();
      }
    }

    if (sc.staged) {
      await caches.open(sc.staged.cache);
      await setStaged(sc.staged);
    }

    if (typeof sc.seed === 'number') {
      await writeMeta('/_nlpwa/rollout-seed.json', { seed: sc.seed });
    }

    if (sc.blockedVersions) {
      for (const b of sc.blockedVersions) {
        await blockVersion(b);
      }
    }

    if (sc.activeBlocked && sc.activeVersion) {
      await blockVersion(sc.activeVersion);
    }

    // Configure server for the test under evaluation
    if (sc.serverVersion) {
      server.set(sc.serverVersion, v2Files);
      if (sc.serverChannel) server.channel = sc.serverChannel;
      if (typeof sc.rolloutPercent === 'number') server.rolloutPercent = sc.rolloutPercent;
    }

    const result = await checkForUpdate();

    // Verify expected output fields
    for (const [key, val] of Object.entries(sc.expected)) {
      if (key === 'stagedAfter') {
        assert.equal(await getStaged(), val);
      } else {
        assert.equal(result[key], val, `Expected result.${key} to equal ${val}`);
      }
    }
  });
}
