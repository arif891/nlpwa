import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, isNewer, incrementPatch } from '../src/shared/version.js';

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
