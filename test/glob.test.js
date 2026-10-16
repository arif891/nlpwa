import test from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, globToRegex } from '../src/shared/glob.js';

test('glob matcher: exact and prefix matching', () => {
  assert.equal(matchGlob('/index.html', '/index.html'), true);
  assert.equal(matchGlob('/index.html', '/other.html'), false);
  assert.equal(matchGlob('/assets/*', '/assets/main.css'), true);
  assert.equal(matchGlob('/assets/*', '/assets/sub/deep.css'), false);
});

test('glob matcher: recursive globstar **', () => {
  assert.equal(matchGlob('/assets/**', '/assets/sub/deep.css'), true);
  assert.equal(matchGlob('/**', '/anything/at/all'), true);
  assert.equal(matchGlob('**', '/anything'), true);
});

test('glob matcher: edge case /**/foo.js matches /foo.js and nested', () => {
  assert.equal(matchGlob('/**/foo.js', '/foo.js'), true);
  assert.equal(matchGlob('/**/foo.js', '/nested/foo.js'), true);
  assert.equal(matchGlob('/**/foo.js', '/deeply/nested/foo.js'), true);
  assert.equal(matchGlob('/**/foo.js', '/foo.css'), false);
});
