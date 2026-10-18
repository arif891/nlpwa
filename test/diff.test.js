import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff, computeRefreshDiff } from '../src/sw/update/diff.js';

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

test('computeDiff: rejects cross-origin, protocol-relative, and traversal paths', () => {
  const oldFiles = [];
  const newFiles = [
    { path: '/config.json', hash: 'aaaa' },
    { path: 'https://evil.com/malicious.js', hash: 'xxxx' },
    { path: '//evil.com/evil.js', hash: 'yyyy' },
    { path: '/\\evil.com/x', hash: 'zzzz1' },
    { path: '\\\\evil.com/x', hash: 'zzzz2' },
    { path: '/../traversal.js', hash: 'zzzz3' },
    { path: '/foo/../bar.js', hash: 'zzzz4' },
    { path: 'javascript:alert(1)', hash: 'zzzz5' },
    { path: 'relative/path.js', hash: 'zzzz6' },
  ];
  const diff = computeDiff(newFiles, oldFiles);

  assert.deepEqual(diff.added, ['/config.json']);
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.removed, []);
});


test('computeRefreshDiff: refetches everything but still reports orphans as removed', () => {
  const diff = computeRefreshDiff(
    [{ path: '/a.js', hash: '1' }, { path: '/b.js', hash: '2' }],
    [{ path: '/a.js', hash: '1' }, { path: '/gone.js', hash: '9' }],
  );
  assert.deepEqual(diff.added.sort(), ['/a.js', '/b.js']);
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.removed, ['/gone.js']);
});

test('computeRefreshDiff: null old snapshot has nothing to remove', () => {
  const diff = computeRefreshDiff([{ path: '/a.js', hash: '1' }], null);
  assert.deepEqual(diff, { added: ['/a.js'], modified: [], removed: [] });
});
