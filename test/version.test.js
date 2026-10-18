import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, isNewer, incrementPatch } from '../src/shared/version.js';
import { computeManifestHash } from '../bin/build-utils.js';

test('version: compare and isNewer', () => {
  assert.equal(compare('1.0.0', '1.0.1'), -1);
  assert.equal(compare('1.1.0', '1.0.9'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);

  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
});

test('version: incrementPatch', () => {
  assert.equal(incrementPatch('1.0.0'), '1.0.1');
  assert.equal(incrementPatch('2.4.9'), '2.4.10');
  assert.equal(incrementPatch(''), '1.0.1');
});

test('computeManifestHash: ignores top-level version but preserves nested updateAPI.version', () => {
  const files = [{ path: '/app.js', hash: 'a1b2c3d4' }];

  // Top-level version differences must NOT change the manifest hash (prevents circular hash dependency)
  const config1 = { version: '1.0.0', updateAPI: { version: '/api/version.json', info: '/api/info.json' } };
  const config2 = { version: '2.0.0', updateAPI: { version: '/api/version.json', info: '/api/info.json' } };
  assert.equal(computeManifestHash(files, config1), computeManifestHash(files, config2));

  // Nested version (such as updateAPI.version endpoint path) MUST change the manifest hash
  const config3 = { version: '1.0.0', updateAPI: { version: '/api/v2/version.json', info: '/api/info.json' } };
  assert.notEqual(computeManifestHash(files, config1), computeManifestHash(files, config3));
});
