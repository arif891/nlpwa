import { getConfig } from '../config/index.js';
import { STRATEGIES } from '../../shared/constants.js';
import {
  cacheFirst,
  networkFirst,
  networkOnly,
  staleWhileRevalidate,
  cacheOnly,
} from './strategies/index.js';

/** Map strategy name → strategy function */
const STRATEGY_FN = {
  [STRATEGIES.CACHE_FIRST]:            cacheFirst,
  [STRATEGIES.NETWORK_FIRST]:          networkFirst,
  [STRATEGIES.NETWORK_ONLY]:           networkOnly,
  [STRATEGIES.STALE_WHILE_REVALIDATE]: staleWhileRevalidate,
  [STRATEGIES.CACHE_ONLY]:             cacheOnly,
};

import { getActiveSnapshotPaths } from '../cache/store.js';

const _routePatternCache = new WeakMap();
const _stringPatternCache = new Map();
const MAX_PATTERN_CACHE = 100;

/**
 * Compile or retrieve a cached URLPattern for a route definition or pattern string/object.
 *
 * @param {Object|string|URLPattern} routeOrPattern
 * @param {string} [defaultOrigin='http://localhost']
 * @returns {URLPattern|null}
 */
export function compileRoutePattern(routeOrPattern, defaultOrigin = 'http://localhost') {
  if (typeof routeOrPattern === 'object' && routeOrPattern !== null && _routePatternCache.has(routeOrPattern)) {
    return _routePatternCache.get(routeOrPattern);
  }

  const input = typeof routeOrPattern === 'string'
    ? routeOrPattern
    : (routeOrPattern?.pattern ?? routeOrPattern?.match ?? routeOrPattern);
  if (!input) return null;

  if (typeof URLPattern !== 'undefined' && input instanceof URLPattern) {
    if (typeof routeOrPattern === 'object' && routeOrPattern !== null) {
      _routePatternCache.set(routeOrPattern, input);
    }
    return input;
  }

  let pattern = null;
  const routeOrigin = routeOrPattern?.origin;

  try {
    if (typeof input === 'object' && input !== null) {
      if (routeOrigin === '*') {
        pattern = new URLPattern({ protocol: '*', hostname: '*', port: '*', ...input });
      } else if (routeOrigin) {
        pattern = new URLPattern({ baseURL: routeOrigin, ...input });
      } else if (!input.baseURL && !input.hostname) {
        pattern = new URLPattern({ baseURL: defaultOrigin, ...input });
      } else {
        pattern = new URLPattern(input);
      }
    } else if (typeof input === 'string') {
      const cacheKey = `${routeOrigin || ''}::${defaultOrigin}::${input}`;
      if (_stringPatternCache.has(cacheKey)) {
        pattern = _stringPatternCache.get(cacheKey);
        if (typeof routeOrPattern === 'object' && routeOrPattern !== null) {
          _routePatternCache.set(routeOrPattern, pattern);
        }
        return pattern;
      }

      if (input.startsWith('http://') || input.startsWith('https://')) {
        pattern = new URLPattern(input);
      } else if (input.startsWith('//')) {
        pattern = new URLPattern('https:' + input);
      } else if (routeOrigin === '*') {
        const pathname = input.startsWith('/') ? input : '/' + input;
        pattern = new URLPattern({ pathname, protocol: '*', hostname: '*', port: '*' });
      } else if (routeOrigin) {
        pattern = new URLPattern(input, routeOrigin);
      } else {
        pattern = new URLPattern(input, defaultOrigin);
      }

      if (_stringPatternCache.size >= MAX_PATTERN_CACHE) {
        const oldest = _stringPatternCache.keys().next().value;
        if (oldest !== undefined) _stringPatternCache.delete(oldest);
      }
      _stringPatternCache.set(cacheKey, pattern);
    }
  } catch {
    pattern = null;
  }

  if (typeof routeOrPattern === 'object' && routeOrPattern !== null && pattern) {
    _routePatternCache.set(routeOrPattern, pattern);
  }
  return pattern;
}

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
  if (config.base) {
    const cleanBase = config.base.replace(/\/+$/, '');
    if (cleanBase) {
      if (pathname === cleanBase || pathname.startsWith(cleanBase + '/')) {
        pathname = pathname.slice(cleanBase.length);
        if (!pathname.startsWith('/')) pathname = '/' + pathname;
      } else {
        // Request is outside configured subpath base; it cannot belong to this app's manifest/precache
        return false;
      }
    }
  }

  // 1. Runtime config file is always an app shell asset
  const configPath = config.configPath || '/api/update/config.json';
  if (pathname === configPath) return true;

  // 2. Precache files and URLPattern / glob patterns
  const precache = config.precache || [];
  for (const item of precache) {
    if (!item) continue;
    if (typeof item !== 'string' && (typeof item !== 'object' || item === null)) continue;

    const itemPath = typeof item === 'string' ? item : item.pathname;
    if (typeof itemPath === 'string') {
      if (itemPath === pathname) {
        return true;
      }
      // Handle root / index.html alias
      if (
        (pathname === '/' && (itemPath === '/index.html' || itemPath === 'index.html')) ||
        (pathname === '/index.html' && itemPath === '/')
      ) {
        return true;
      }
    }

    const pattern = compileRoutePattern(item, requestUrl.origin);
    if (pattern && (pattern.test(requestUrl.href) || pattern.test(pathname, requestUrl.origin))) {
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
 * Match a request URL against configured routes using native URLPattern.
 * Handles named parameter extraction, origin matching, base stripping, full URL match patterns, and wildcards.
 *
 * @param {URL} requestUrl
 * @param {Array<Object>} routes
 * @param {Object} [config]
 * @returns {Object|null} matched route object with params and urlPatternResult or null
 */
export function matchRoute(requestUrl, routes = [], config = {}) {
  const defaultOrigin = typeof self !== 'undefined' && self.location?.origin
    ? self.location.origin
    : (requestUrl?.origin || 'http://localhost');

  let appPathname = requestUrl.pathname;
  let isUnderBase = true;
  if (config.base) {
    const cleanBase = config.base.replace(/\/+$/, '');
    if (cleanBase) {
      if (appPathname === cleanBase || appPathname.startsWith(cleanBase + '/')) {
        appPathname = appPathname.slice(cleanBase.length);
        if (!appPathname.startsWith('/')) appPathname = '/' + appPathname;
      } else {
        isUnderBase = false;
      }
    }
  }

  let appUrl = null;
  if (isUnderBase && config.base) {
    try {
      appUrl = new URL(appPathname + (requestUrl.search || '') + (requestUrl.hash || ''), requestUrl.origin);
    } catch {
      appUrl = null;
    }
  }

  for (const route of routes) {
    const pattern = compileRoutePattern(route, defaultOrigin);
    if (!pattern) continue;

    let match = pattern.exec(requestUrl.href);
    if (!match && appUrl) {
      match = pattern.exec(appUrl.href);
    }

    if (match) {
      const params = {};
      if (match.pathname?.groups) {
        for (const [k, v] of Object.entries(match.pathname.groups)) {
          if (v !== undefined && (v !== '' || !/^\d+$/.test(k))) {
            params[k] = v;
          }
        }
      }
      if (match.search?.groups) {
        for (const [k, v] of Object.entries(match.search.groups)) {
          if (v !== undefined && (v !== '' || !/^\d+$/.test(k))) {
            params[k] = v;
          }
        }
      }
      return {
        ...route,
        params,
        urlPatternResult: match,
      };
    }
  }

  return null;
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

  // Non-GET requests (mutations) are routed through network-only with plugin hooks
  if (request.method !== 'GET') {
    const matchedRoute = matchRoute(requestUrl, routes, config);
    const handler = (req, event) => networkOnly(req, event, matchedRoute || {});
    handler.strategy = 'network-only';
    handler.route = matchedRoute;
    handler.params = matchedRoute?.params || {};
    return handler;
  }

  // Built-in non-overridable rule: Precached / manifest files are ALWAYS served
  // from the active offline cache (cache-first). This guarantees that online
  // requests never bypass the staged cache or produce mixed old/new files.
  if (isManifestFile(requestUrl, getConfig())) {
    const handler = (req, event) => cacheFirst(req, event);
    handler.strategy = 'cache-first';
    return handler;
  }

  const matchedRoute = matchRoute(requestUrl, routes, config);
  if (matchedRoute) {
    const fn = STRATEGY_FN[matchedRoute.strategy] ?? STRATEGY_FN[defaultStrategy] ?? networkFirst;
    const handler = (req, event) => fn(req, event, matchedRoute);
    handler.strategy = matchedRoute.strategy;
    handler.route = matchedRoute;
    handler.params = matchedRoute.params;
    return handler;
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
