/**
 * Helper to resolve paths against a configured base subpath (e.g. '/my-app/').
 *
 * - Leaves URLs with schemes (http://, https://) or protocol-relative (//) untouched.
 * - Handles trailing slash in base and leading slash in path gracefully.
 * - Avoids double-prefixing if path is already prefixed with base.
 *
 * @param {string} path
 * @param {string} [base]
 * @returns {string}
 */
export function resolvePathWithBase(path, base) {
  if (!path || !base || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    return path;
  }
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  if (!cleanBase) return path;

  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (cleanPath === cleanBase || cleanPath.startsWith(`${cleanBase}/`)) {
    return cleanPath;
  }
  return `${cleanBase}${cleanPath}`;
}
