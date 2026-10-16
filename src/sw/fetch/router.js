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

  for (const route of routes) {
    if (matchGlob(route.match, request.url)) {
      return STRATEGY_FN[route.strategy] ?? STRATEGY_FN[defaultStrategy];
    }
  }

  return STRATEGY_FN[defaultStrategy];
}
