/** Compiled regex cache — avoids recompiling the same glob on every fetch event */
const MAX_REGEX_CACHE_SIZE = 100;
const _regexCache = new Map();

/** Clear compiled regex cache (e.g. for testing or config reloads) */
export function clearGlobCache() {
  _regexCache.clear();
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   **   matches anything, including path separators  e.g. /assets/**
 *   *    matches anything except /                    e.g. /pages/*
 *   ?    matches a single character except /
 *
 * Results are memoized per pattern string.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  if (_regexCache.has(pattern)) return _regexCache.get(pattern);

  const regexStr = pattern
    // Escape all regex special chars except our glob chars (* ?)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Handle /**/ to allow matching 0 or more directory levels (e.g. /**/foo.js matches /foo.js and /a/b/foo.js)
    .replace(/\/\*\*\//g, '\x00GLOBSTARSLASH\x00')
    // Replace standalone **
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    // * → match anything except /
    .replace(/\*/g, '[^/]*')
    // ? → match single char except /
    .replace(/\?/g, '[^/]')
    // Restore placeholders AFTER single * has been replaced
    .replace(/\x00GLOBSTARSLASH\x00/g, '/(?:.*/)?')
    .replace(/\x00GLOBSTAR\x00/g, '.*');

  const regex = new RegExp('^' + regexStr + '$');

  if (_regexCache.size >= MAX_REGEX_CACHE_SIZE) {
    const oldestKey = _regexCache.keys().next().value;
    if (oldestKey !== undefined) _regexCache.delete(oldestKey);
  }

  _regexCache.set(pattern, regex);
  return regex;
}

/**
 * Test if a full URL's pathname matches a glob pattern.
 *
 * @param {string} pattern  glob pattern, e.g. '/api/**'
 * @param {string} url      full URL string, e.g. 'https://example.com/api/user'
 * @returns {boolean}
 */
export function matchGlob(pattern, url) {
  try {
    if (pattern.startsWith('http://') || pattern.startsWith('https://') || pattern.startsWith('//')) {
      const full = typeof url === 'string' ? url : url.href;
      return globToRegex(pattern).test(full);
    }
    const { pathname } = new URL(url, 'http://localhost');
    return globToRegex(pattern).test(pathname);
  } catch {
    return false;
  }
}
