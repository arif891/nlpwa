import { DEFAULTS } from './defaults.js';
import { validateConfig } from './schema.js';
import { openActive } from '../cache/store.js';

/** Singleton config instance, set by initConfig() */
let _config = null;

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
    // Deep merge nested objects
    caches: {
      ...DEFAULTS.caches,
      ...(userConfig.caches ?? {}),
    },
  };

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    console.error('[NLPWA] Config errors:\n' + errors.map(e => `  • ${e}`).join('\n'));
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
 * (e.g. loaded from /config.json in the offline cache).
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
    // Preserve manual SW version if not provided or keep engine version
    version: _config.version,
    appVersion: runtimeConfig.version ?? _config.appVersion ?? runtimeConfig.appVersion,
    // Deep merge nested caches
    caches: {
      ..._config.caches,
      ...(runtimeConfig.caches ?? {}),
    },
    // Merge updateAPI
    updateAPI: runtimeConfig.updateAPI ?? _config.updateAPI,
    // Runtime routes take priority
    routes: Array.isArray(runtimeConfig.routes) ? runtimeConfig.routes : _config.routes,
    precache: Array.isArray(runtimeConfig.precache) ? runtimeConfig.precache : _config.precache,
  };

  _config = Object.freeze(merged);
  return _config;
}

let _configReadyPromise = null;

/**
 * Ensure runtime config has been loaded from the offline cache before handling requests.
 * Resolves immediately if already loaded or previously started.
 *
 * @returns {Promise<Object|null>}
 */
export function ensureConfigReady() {
  if (!_configReadyPromise) {
    _configReadyPromise = loadConfigFromCache();
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
  const configPath = config.configPath || '/config.json';

  try {
    const cache = await openActive(baseName);
    const response = await cache.match(configPath);
    if (!response) return null;

    const runtimeJson = await response.json();
    updateActiveConfig(runtimeJson);
    console.log(`[NLPWA] Runtime config loaded from offline cache (${configPath})`);
    return runtimeJson;
  } catch (err) {
    console.warn(`[NLPWA] Could not load config from offline cache: ${err.message}`);
    return null;
  }
}

/**
 * Helper to resolve the two-tier update API endpoints:
 * - versionEndpoint: lightweight check
 * - infoEndpoint: full manifest
 *
 * Supports both object: { version, info }
 * and array: [ { type: 'version', endpoint }, { type: 'info', endpoint } ]
 *
 * @returns {{ versionEndpoint: string, infoEndpoint: string }}
 */
export function getUpdateEndpoints() {
  const config = getConfig();
  let versionEndpoint = '/api/update/version';
  let infoEndpoint = '/api/update/info';

  if (config.updateAPI) {
    if (Array.isArray(config.updateAPI)) {
      const vEntry = config.updateAPI.find(e => e.type === 'version');
      const iEntry = config.updateAPI.find(e => e.type === 'info');
      if (vEntry?.endpoint) versionEndpoint = vEntry.endpoint;
      if (iEntry?.endpoint) infoEndpoint = iEntry.endpoint;
    } else if (typeof config.updateAPI === 'object') {
      if (config.updateAPI.version) versionEndpoint = config.updateAPI.version;
      if (config.updateAPI.info) infoEndpoint = config.updateAPI.info;
    }
  }

  return { versionEndpoint, infoEndpoint };
}
