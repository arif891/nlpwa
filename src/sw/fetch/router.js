import { getConfig } from '../config/index.js';
import { matchGlob } from '../../shared/glob.js';
import { STRATEGIES } from '../../shared/constants.js';
import {
  cacheFirst,
  networkFirst,
  networkOnly,
  staleWhileRevalidate,
  cacheOnly,
} from './strategies.js';

/** Map strategy name → strategy function */
const STRATEGY_FN = {
  [STRATEGIES.CACHE_FIRST]:            cacheFirst,
  [STRATEGIES.NETWORK_FIRST]:          networkFirst,
  [STRATEGIES.NETWORK_ONLY]:           networkOnly,
  [STRATEGIES.STALE_WHILE_REVALIDATE]: staleWhileRevalidate,
  [STRATEGIES.CACHE_ONLY]:             cacheOnly,
};

/**
 * Resolve the strategy function for a given Request by matching it against
 * config.routes (top-to-bottom, first match wins).
 * Falls back to config.defaultStrategy if no route matches.
 *
 * @param {Request} request
 * @returns {Function}  one of the five strategy functions
 */
export function resolveStrategy(request) {
  const { routes, defaultStrategy } = getConfig();

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return (req, event) => networkOnly(req, event);
  }

  const isSameOrigin = typeof self !== 'undefined' && self.location
    ? requestUrl.origin === self.location.origin
    : true;

  for (const route of routes) {
    // If route specifies an origin (e.g. origin: 'https://cdn.example.com' or '*'),
    // match against that. Otherwise default to same-origin only.
    if (route.origin) {
      if (route.origin !== '*' && route.origin !== requestUrl.origin) {
        continue;
      }
    } else if (!isSameOrigin) {
      // Unspecified origin matches ONLY same-origin requests
      continue;
    }

    if (matchGlob(route.match, requestUrl.pathname)) {
      const fn = STRATEGY_FN[route.strategy] ?? STRATEGY_FN[defaultStrategy] ?? networkFirst;
      return (req, event) => fn(req, event, route);
    }
  }

  // Cross-origin requests without an explicit origin route pass through without caching
  if (!isSameOrigin) {
    return (req, event) => networkOnly(req, event);
  }

  const defaultFn = STRATEGY_FN[defaultStrategy] ?? networkFirst;
  return (req, event) => defaultFn(req, event);
}
