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

/**
 * Resolve version and info API endpoint paths from runtime config or updateAPI configuration.
 * Supports both object format { version, info } and array format [{ type: 'version', endpoint }, ...].
 *
 * @param {Object} [config]
 * @returns {{ versionEndpoint: string, infoEndpoint: string }}
 */
export function resolveUpdateEndpoints(config = {}) {
  let versionEndpoint = '/api/update/version.json';
  let infoEndpoint = '/api/update/info.json';

  let updateAPI = config?.updateAPI;
  if (updateAPI === undefined) {
    if (
      Array.isArray(config) ||
      config?.info ||
      (typeof config?.version === 'string' && (config.version.startsWith('/') || config.version.endsWith('.json')))
    ) {
      updateAPI = config;
    }
  }

  if (updateAPI) {
    if (typeof updateAPI === 'object' && !Array.isArray(updateAPI)) {
      if (updateAPI.version) versionEndpoint = updateAPI.version;
      if (updateAPI.info) infoEndpoint = updateAPI.info;
    } else if (Array.isArray(updateAPI)) {
      const v = updateAPI.find((e) => e?.type === 'version');
      const i = updateAPI.find((e) => e?.type === 'info');
      if (v?.endpoint) versionEndpoint = v.endpoint;
      if (i?.endpoint) infoEndpoint = i.endpoint;
    }
  }

  let timeoutMs = typeof config?.updateTimeoutMs === 'number' ? config.updateTimeoutMs : undefined;
  if (timeoutMs === undefined && updateAPI && typeof updateAPI === 'object' && !Array.isArray(updateAPI)) {
    if (typeof updateAPI.timeoutMs === 'number') {
      timeoutMs = updateAPI.timeoutMs;
    }
  }

  if (config?.base) {
    versionEndpoint = resolvePathWithBase(versionEndpoint, config.base);
    infoEndpoint = resolvePathWithBase(infoEndpoint, config.base);
  }

  return { versionEndpoint, infoEndpoint, timeoutMs };
}
