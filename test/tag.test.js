import test from 'node:test';
import assert from 'node:assert/strict';
import { tagResponse, CACHE_STATUS, CACHE_STATUS_HEADER } from '../src/sw/cache/tag.js';

test('tagResponse: attaches X-Cache-Status header to standard responses', async () => {
  const res = new Response('hello', { status: 200 });
  const tagged = tagResponse(res, CACHE_STATUS.OFFLINE_CACHE);

  assert.equal(tagged.headers.get(CACHE_STATUS_HEADER), CACHE_STATUS.OFFLINE_CACHE);
  assert.equal(await tagged.text(), 'hello');
});

test('tagResponse: safely skips opaque and status 0 responses without throwing RangeError', () => {
  const fakeOpaque = { type: 'opaque', status: 0 };
  const res1 = tagResponse(fakeOpaque, CACHE_STATUS.NETWORK);
  assert.equal(res1, fakeOpaque);

  const fakeOpaqueRedirect = { type: 'opaqueredirect', status: 0 };
  const res2 = tagResponse(fakeOpaqueRedirect, CACHE_STATUS.NETWORK);
  assert.equal(res2, fakeOpaqueRedirect);
});
