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

  // Always bypass Vite internal dev requests and HMR updates directly to network
  if (
    requestUrl.pathname.startsWith('/@vite/') ||
    requestUrl.pathname.startsWith('/@fs/') ||
    requestUrl.pathname.includes('/.vite/') ||
    requestUrl.pathname.endsWith('.hot-update.json') ||
    requestUrl.searchParams.has('import')
  ) {
    return (req, event) => networkOnly(req, event);
  }

  for (const route of routes) {
    let routeOrigin = route.origin;
    let matchPattern = route.match;

    // Support full URL patterns directly in match: "https://cdn.jsdelivr.net/npm/**"
    if (!routeOrigin && (matchPattern.startsWith('http://') || matchPattern.startsWith('https://'))) {
      try {
        routeOrigin = new URL(matchPattern.replace(/\*/g, 'x')).origin;
      } catch {
        // fallback
      }
    }

    // If route specifies an origin (e.g. origin: 'https://cdn.example.com' or '*'),
    // match against that. Otherwise default to same-origin only.
    if (routeOrigin) {
      if (routeOrigin !== '*' && routeOrigin !== requestUrl.origin) {
        continue;
      }
    } else if (!isSameOrigin) {
      // Unspecified origin matches ONLY same-origin requests
      continue;
    }

    if (matchGlob(matchPattern, requestUrl.href) || matchGlob(matchPattern, requestUrl.pathname)) {
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
