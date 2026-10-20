import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers/fake-env.js';
import { makeServer } from './helpers/fake-server.js';
import { checkForUpdate } from '../src/sw/update/index.js';
import { precacheFiles } from '../src/sw/cache/install.js';
import {
  pinClient,
  getClientPinnedVersion,
  unpinClientsBelowVersion,
  setMinVersion,
} from '../src/sw/cache/meta/index.js';
import { handleMessage } from '../src/sw/events/message.js';
import { MESSAGE_TYPES } from '../src/shared/constants.js';

const cfg = () => JSON.stringify({
  version: '1',
  caches: { offline: 'offline', runtime: 'runtime' },
  routes: [{ match: '**', strategy: 'network-first' }],
  precache: ['/api/update/config.json', '/app.js'],
});

test('minVersion: unpinClientsBelowVersion removes pins for versions older than minVersion', async () => {
  const server = makeServer('1.0.0', { '/api/update/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);

  pinClient('tab-v1-old', 'offline@1.0.0-1', '1.0.0');
  pinClient('tab-v1-minor', 'offline@1.4.0-1', '1.4.0');
  pinClient('tab-v2-ok', 'offline@2.0.0-1', '2.0.0');

  assert.equal(getClientPinnedVersion('tab-v1-old'), '1.0.0');
  assert.equal(getClientPinnedVersion('tab-v1-minor'), '1.4.0');
  assert.equal(getClientPinnedVersion('tab-v2-ok'), '2.0.0');

  // Require minimum version 1.5.0
  const unpinned = await unpinClientsBelowVersion('1.5.0');
  assert.deepEqual(unpinned.sort(), ['tab-v1-minor', 'tab-v1-old']);

  // Verify older tabs are unpinned while newer tabs remain pinned
  assert.equal(getClientPinnedVersion('tab-v1-old'), null);
  assert.equal(getClientPinnedVersion('tab-v1-minor'), null);
  assert.equal(getClientPinnedVersion('tab-v2-ok'), '2.0.0');
});

test('minVersion: checkForUpdate broadcasts UPDATE_REQUIRED when active version < minVersion', async () => {
  // Initial install at 1.0.0
  const server = makeServer('1.0.0', { '/api/update/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);
  await precacheFiles();

  // Connected client mock
  const messages = [];
  globalThis.self.clients = {
    matchAll: async () => [{
      id: 'tab-1',
      postMessage: (msg) => messages.push(msg),
    }],
  };

  // Backend updates to 3.0.0 with minVersion 2.0.0 (breaking API changes)
  server.set('3.0.0', { '/api/update/config.json': cfg(), '/app.js': 'app v3' }, '2.0.0');

  await checkForUpdate({ force: true });

  const requiredMsg = messages.find((m) => m.type === MESSAGE_TYPES.UPDATE_REQUIRED);
  assert.ok(requiredMsg, 'SW must broadcast UPDATE_REQUIRED when active version falls below minVersion');
  assert.equal(requiredMsg.minVersion, '2.0.0');
  assert.equal(requiredMsg.activeVersion, '1.0.0');
});

test('minVersion: GET_VERSION reports updateRequired: true when client is below minVersion', async () => {
  const server = makeServer('1.0.0', { '/api/update/config.json': cfg(), '/app.js': 'app v1' });
  setupEnv(server.fetch);
  await precacheFiles();

  // Set minVersion to 2.0.0 in metadata
  await setMinVersion('2.0.0');

  const handler = handleMessage({ version: '1', caches: { offline: 'offline' } });

  let replyData = null;
  const event = {
    data: { type: MESSAGE_TYPES.GET_VERSION, requestId: 'req-1' },
    source: { id: 'tab-client' },
    ports: [{
      postMessage: (payload) => { replyData = payload.data; },
    }],
    waitUntil: (p) => p,
  };

  handler(event);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(replyData);
  assert.equal(replyData.minVersion, '2.0.0');
  assert.equal(replyData.updateRequired, true, 'updateRequired must be true when version is below minVersion');
});
