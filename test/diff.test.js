import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../src/sw/update/diff.js';

test('computeDiff: fresh install (oldFiles is null)', () => {
  const newFiles = [
    { path: '/config.json', hash: 'aaaa' },
    { path: '/app.js', hash: 'bbbb' },
  ];
  const diff = computeDiff(newFiles, null);

  assert.deepEqual(diff.added.sort(), ['/app.js', '/config.json']);
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.removed, []);
});

test('computeDiff: detects modified and removed files', () => {
  const oldFiles = [
    { path: '/config.json', hash: 'aaaa' },
    { path: '/app.js', hash: 'bbbb' },
    { path: '/old.css', hash: 'cccc' },
  ];
  const newFiles = [
    { path: '/config.json', hash: 'aaaa' }, // unchanged
    { path: '/app.js', hash: 'newhash' },   // modified
    { path: '/new.png', hash: 'dddd' },      // added
  ];
  const diff = computeDiff(newFiles, oldFiles);

  assert.deepEqual(diff.added, ['/new.png']);
  assert.deepEqual(diff.modified, ['/app.js']);
  assert.deepEqual(diff.removed, ['/old.css']);
});

test('computeDiff: rejects cross-origin and scheme-relative paths', () => {
  const oldFiles = [];
  const newFiles = [
    { path: '/config.json', hash: 'aaaa' },
    { path: 'https://evil.com/malicious.js', hash: 'xxxx' },
    { path: '//evil.com/evil.js', hash: 'yyyy' },
    { path: 'javascript:alert(1)', hash: 'zzzz' },
  ];
  const diff = computeDiff(newFiles, oldFiles);

  assert.deepEqual(diff.added, ['/config.json']);
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.removed, []);
});
