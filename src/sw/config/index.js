import { DEFAULTS } from './defaults.js';
import { validateConfig } from './schema.js';

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
