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

import { getActiveSnapshotPaths } from '../update/manifest.js';

/**
 * Check whether a request URL corresponds to a precached app shell or manifest file.
 *
 * @param {URL} requestUrl
 * @param {Object} [config]
 * @returns {boolean}
 */
export function isManifestFile(requestUrl, config = getConfig()) {
  if (!config) return false;

  const isSameOrigin = typeof self !== 'undefined' && self.location
    ? requestUrl.origin === self.location.origin
    : true;

  if (!isSameOrigin) return false;

  let pathname = requestUrl.pathname;
  if (config.base && pathname.startsWith(config.base)) {
    pathname = pathname.slice(config.base.length);
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
  }

  // 1. Runtime config file is always an app shell asset
  const configPath = config.configPath || '/config.json';
  if (pathname === configPath) return true;

  // 2. Precache files and glob patterns
  const precache = config.precache || [];
  for (const item of precache) {
    if (typeof item !== 'string') continue;
    if (item === pathname || matchGlob(item, pathname)) {
      return true;
    }
    // Handle root / index.html alias
    if (
      (pathname === '/' && (item === '/index.html' || item === 'index.html')) ||
      (pathname === '/index.html' && item === '/')
    ) {
      return true;
    }
  }

  // 3. Active snapshot files (if hydrated in memory)
  const snapshotFiles = getActiveSnapshotPaths();
  if (snapshotFiles && snapshotFiles.has(pathname)) {
    return true;
  }

  return false;
}

/**
 * Resolve the strategy function for a given Request by matching it against
 * config.routes (top-to-bottom, first match wins).
 * Falls back to config.defaultStrategy if no route matches.
 *
 * Built-in non-overridable rule: Manifest and precached app shell files are
 * ALWAYS served cache-first from the active offline cache to protect update
 * atomicity and prevent online requests from bypassing the staged cache.
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

  // Dev-only bypass: when dev: true or devBypass: true, route Vite internal requests
  // and HMR updates directly to network instead of caching or intercepting them.
  const config = getConfig();
  if (config.dev || config.devBypass) {
    if (
      requestUrl.pathname.startsWith('/@vite/') ||
      requestUrl.pathname.startsWith('/@fs/') ||
      requestUrl.pathname.includes('/.vite/') ||
      requestUrl.pathname.endsWith('.hot-update.json') ||
      requestUrl.searchParams.has('import')
    ) {
      const handler = (req, event) => networkOnly(req, event);
      handler.strategy = 'network-only';
      return handler;
    }
  }

  // Built-in non-overridable rule: Precached / manifest files are ALWAYS served
  // from the active offline cache (cache-first). This guarantees that online
  // requests never bypass the staged cache or produce mixed old/new files.
  if (isManifestFile(requestUrl, getConfig())) {
    const handler = (req, event) => cacheFirst(req, event);
    handler.strategy = 'cache-first';
    return handler;
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
      const handler = (req, event) => fn(req, event, route);
      handler.strategy = route.strategy;
      return handler;
    }
  }

  // Cross-origin requests without an explicit origin route pass through without caching
  if (!isSameOrigin) {
    const handler = (req, event) => networkOnly(req, event);
    handler.strategy = 'network-only';
    return handler;
  }

  const defaultFn = STRATEGY_FN[defaultStrategy] ?? networkFirst;
  const handler = (req, event) => defaultFn(req, event);
  handler.strategy = defaultStrategy;
  return handler;
}
