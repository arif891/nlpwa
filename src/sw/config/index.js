import { DEFAULTS } from './defaults.js';
import { validateConfig } from './schema.js';
import { openActive, setMetaCacheName, setActiveSnapshotPaths } from '../cache/store.js';
import { resolvePathWithBase, resolveUpdateEndpoints } from '../../shared/url.js';
import { createLogger } from '../../shared/logger.js';

export { resolvePathWithBase, resolveUpdateEndpoints };

/** Singleton config instance, set by initConfig() */
let _config = null;
const logger = createLogger(() => _config);

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) return routes;
  return routes.map((r) => {
    if (r && typeof r === 'object' && r.options && typeof r.options === 'object') {
      const { options, ...rest } = r;
      return { ...rest, ...options };
    }
    return r;
  });
}

/**
 * Initialize the NLPWA config by merging user config with defaults.
 * Should be called once at the top of the SW entry point.
 *
 * @param {Partial<typeof DEFAULTS>} userConfig
 * @returns {typeof DEFAULTS}
 */
export function initConfig(userConfig = {}) {
  const merged = {
    ...DEFAULTS,
    ...userConfig,
    routes: normalizeRoutes(userConfig.routes ?? DEFAULTS.routes),
    // Deep merge nested objects
    caches: {
      ...DEFAULTS.caches,
      ...(userConfig.caches ?? {}),
    },
  };

  if (merged.caches?.meta) {
    setMetaCacheName(merged.caches.meta);
  }

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    logger.error('[NLPWA] Config errors:\n' + errors.map(e => `  • ${e}`).join('\n'));
  }

  _config = Object.freeze(merged);
  return _config;
}

/**
 * Get the active config. Throws if initConfig() has not been called.
 *
 * @returns {typeof DEFAULTS}
 */
export function getConfig() {
  if (!_config) {
    throw new Error('[NLPWA] Config not initialized. Call initConfig(userConfig) first.');
  }
  return _config;
}

/**
 * Update the active in-memory configuration with runtime config
 * (e.g. loaded from /api/update/config.json in the offline cache).
 *
 * @param {Object} runtimeConfig
 * @returns {typeof DEFAULTS}
 */
export function updateActiveConfig(runtimeConfig = {}) {
  if (!_config) {
    initConfig();
  }

  const merged = {
    ..._config,
    ...runtimeConfig,
    // Version handling: preserve compiled SW engine version, reflect deployed appVersion
    version: _config.version,
    appVersion: runtimeConfig.version ?? _config.appVersion ?? runtimeConfig.appVersion,

    // Same-origin trust boundary protection:
    // Core security, base path, and storage namespace settings are locked to the compiled SW engine
    // and cannot be downgraded (e.g. verifyHashes: false) or hijacked by a fetched config.json.
    base: _config.base,
    verifyHashes: _config.verifyHashes,
    maxVerifyBytes: _config.maxVerifyBytes,
    allowOversizedUnverified: _config.allowOversizedUnverified,
    skipVerifyGlobs: _config.skipVerifyGlobs,
    caches: _config.caches,
    snapshotCachePath: _config.snapshotCachePath,

    // Runtime routes and precache take priority if provided
    routes: Array.isArray(runtimeConfig.routes) ? normalizeRoutes(runtimeConfig.routes) : _config.routes,
    precache: Array.isArray(runtimeConfig.precache) ? runtimeConfig.precache : _config.precache,
    updateAPI: runtimeConfig.updateAPI ?? _config.updateAPI,
  };

  _config = Object.freeze(merged);
  return _config;
}

let _configReadyPromise = null;

/**
 * Ensure runtime config has been loaded from the offline cache before handling requests.
 * Resolves with the active runtime config.
 *
 * @returns {Promise<Object|null>}
 */
export function ensureConfigReady() {
  if (!_configReadyPromise) {
    _configReadyPromise = loadConfigFromCache().catch((err) => {
      _configReadyPromise = null;
      logger.warn('[NLPWA] Config load failed, will retry:', err?.message || err);
      return null;
    });
  }
  return _configReadyPromise;
}

/**
 * Load the runtime config file from the offline cache.
 * Config is always read from the ACTIVE offline cache at runtime, so it
 * switches together with the rest of the app shell when an update is committed.
 *
 * @returns {Promise<Object|null>}
 */
export async function loadConfigFromCache() {
  const config = _config || initConfig();
  const baseName = config.caches?.offline || 'offline';
  const configPath = resolvePathWithBase(config.configPath || '/api/update/config.json', config.base);

  try {
    const cache = await openActive(baseName);
    const response = await cache.match(configPath);
    if (!response) {
      _configReadyPromise = Promise.resolve(null);
      return null;
    }

    const runtimeJson = await response.json();
    updateActiveConfig(runtimeJson);
    logger.log(`[NLPWA] Runtime config loaded from offline cache (${configPath})`);

    try {
      const snapPath = config.snapshotCachePath || '/_nlpwa/snapshot.json';
      const snapRes = await cache.match(snapPath);
      if (snapRes) {
        const snapData = await snapRes.json();
        if (Array.isArray(snapData?.files)) {
          setActiveSnapshotPaths(snapData.files.map((f) => f.path));
        }
      }
    } catch {
      // snapshot may not exist yet
    }

    _configReadyPromise = Promise.resolve(runtimeJson);
    return runtimeJson;
  } catch (err) {
    logger.warn(`[NLPWA] Could not load config from offline cache: ${err.message}`);
    _configReadyPromise = null;
    return null;
  }
}

/**
 * Helper to resolve the two-tier update API endpoints:
 * - versionEndpoint: lightweight check
 * - infoEndpoint: full manifest
 *
 * Config format: { version, info }
 *
 * @returns {{ versionEndpoint: string, infoEndpoint: string }}
 */
export function getUpdateEndpoints() {
  return resolveUpdateEndpoints(getConfig());
}
