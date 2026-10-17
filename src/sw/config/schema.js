import { STRATEGIES } from '../../shared/constants.js';

const VALID_STRATEGIES = new Set(Object.values(STRATEGIES));

/**
 * Validate a merged config object.
 * Returns an array of error strings (empty = valid).
 *
 * @param {Object} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  const errors = [];

  if (typeof config.version !== 'string' || !config.version) {
    errors.push('config.version must be a non-empty string (e.g. "1", "2", "v3")');
  }

  if (config.configPath && typeof config.configPath !== 'string') {
    errors.push('config.configPath must be a string (e.g. "/config.json")');
  }

  // Validate updateAPI
  if (!config.updateAPI) {
    errors.push('config.updateAPI must be defined with { version, info }');
  } else if (Array.isArray(config.updateAPI)) {
    if (config.updateAPI.length === 0) {
      errors.push('config.updateAPI array must not be empty');
    }
  } else if (typeof config.updateAPI !== 'object') {
    errors.push('config.updateAPI must be an object with { version, info } or an array');
  }

  if (![ 'strict', 'warn', false ].includes(config.verifyHashes)) {
    errors.push("config.verifyHashes must be 'strict', 'warn' or false");
  }

  if (typeof config.updateCheckInterval !== 'number' || config.updateCheckInterval < 0) {
    errors.push('config.updateCheckInterval must be a non-negative number (ms)');
  }

  if (!config.caches || typeof config.caches.offline !== 'string') {
    errors.push('config.caches.offline must be a string');
  }

  if (!config.caches || typeof config.caches.runtime !== 'string') {
    errors.push('config.caches.runtime must be a string');
  }

  if (!Array.isArray(config.precache)) {
    errors.push('config.precache must be an array of URL strings');
  }

  if (!Array.isArray(config.routes)) {
    errors.push('config.routes must be an array');
  } else {
    config.routes.forEach((route, i) => {
      if (typeof route.match !== 'string') {
        errors.push(`config.routes[${i}].match must be a string (glob pattern)`);
      }
      if (!VALID_STRATEGIES.has(route.strategy)) {
        errors.push(
          `config.routes[${i}].strategy "${route.strategy}" is invalid. ` +
          `Valid: ${[...VALID_STRATEGIES].join(', ')}`
        );
      }
    });
  }

  if (!VALID_STRATEGIES.has(config.defaultStrategy)) {
    errors.push(
      `config.defaultStrategy "${config.defaultStrategy}" is invalid. ` +
      `Valid: ${[...VALID_STRATEGIES].join(', ')}`
    );
  }

  return errors;
}
