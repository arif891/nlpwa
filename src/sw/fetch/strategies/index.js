import { cacheFirst } from './cache-first.js';
import { networkFirst } from './network-first.js';
import { networkOnly } from './network-only.js';
import { staleWhileRevalidate } from './stale-while-revalidate.js';
import { cacheOnly } from './cache-only.js';
import { parseDurationMs, resolveMaxAgeMs, isResponseExpired } from '../../../shared/time.js';
import { createRangeResponse } from '../range.js';
import { isNavigationFallbackAllowed } from '../navigation.js';
import {
  getPlugins,
  runRequestWillFetch,
  runCachedResponseWillBeUsed,
  runCacheWillUpdate,
  runFetchDidSucceed,
  runFetchDidFail,
  runCacheDidUpdate,
  runCacheKeyWillBeUsed,
} from '../plugins.js';
import {
  serveCached,
  performFetch,
  safePutInRuntime,
  getShouldThrow,
  resolveFallbackUrl,
  lookupTaggedCache,
} from './context.js';

export {
  cacheFirst,
  networkFirst,
  networkOnly,
  staleWhileRevalidate,
  cacheOnly,
  parseDurationMs,
  resolveMaxAgeMs,
  isResponseExpired,
  createRangeResponse,
  isNavigationFallbackAllowed,
  getPlugins,
  runRequestWillFetch,
  runCachedResponseWillBeUsed,
  runCacheWillUpdate,
  runFetchDidSucceed,
  runFetchDidFail,
  runCacheDidUpdate,
  runCacheKeyWillBeUsed,
  serveCached,
  performFetch,
  safePutInRuntime,
  getShouldThrow,
  resolveFallbackUrl,
  lookupTaggedCache,
};
