import { matchGlob } from '../../shared/glob.js';
import { getConfig } from '../config/index.js';

/**
 * Test whether a URL matches a pattern (glob string, RegExp, or predicate function).
 *
 * @param {string|RegExp|Function} pattern
 * @param {URL} url
 * @returns {boolean}
 */
export function matchesNavigationPattern(pattern, url) {
  if (!pattern) return false;
  if (typeof pattern === 'function') {
    try {
      return Boolean(pattern(url));
    } catch {
      return false;
    }
  }
  if (pattern instanceof RegExp) {
    return pattern.test(url.pathname) || pattern.test(url.href);
  }
  if (typeof URLPattern !== 'undefined' && pattern instanceof URLPattern) {
    return pattern.test(url.href);
  }
  if (typeof pattern === 'string') {
    if (typeof URLPattern !== 'undefined') {
      try {
        const p = new URLPattern(pattern, 'http://localhost');
        if (p.test(url.href) || p.test(url.pathname, 'http://localhost')) {
          return true;
        }
      } catch {
        // Fall back to glob
      }
    }
    return matchGlob(pattern, url.pathname) || matchGlob(pattern, url.href);
  }
  if (typeof pattern === 'object' && pattern !== null && typeof URLPattern !== 'undefined') {
    try {
      const p = new URLPattern(pattern);
      return p.test(url.href);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check whether a navigation request URL is permitted to receive the SPA navigation fallback.
 * Prevents non-SPA paths (such as /api/* or /admin/*) from receiving the index.html shell fallback.
 *
 * @param {string|Request} requestOrUrl
 * @param {Object} [options]
 * @param {Object} [config]
 * @returns {boolean}
 */
export function isNavigationFallbackAllowed(requestOrUrl, options = {}, config = getConfig()) {
  const urlString = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
  let url;
  try {
    url = new URL(urlString, 'http://localhost');
  } catch {
    return false;
  }

  const denylist = options.navigationDenylist ?? config.navigationDenylist ?? [];
  const allowlist = options.navigationAllowlist ?? config.navigationAllowlist ?? [];

  // 1. If URL matches any denylist pattern, fallback is blocked
  if (Array.isArray(denylist)) {
    for (const pattern of denylist) {
      if (matchesNavigationPattern(pattern, url)) {
        return false;
      }
    }
  }

  // 2. If allowlist is specified, URL must match at least one allowlist pattern
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    return allowlist.some((pattern) => matchesNavigationPattern(pattern, url));
  }

  return true;
}
