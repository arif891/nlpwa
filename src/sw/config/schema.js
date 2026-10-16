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
    errors.push('config.version must be a non-empty string (e.g. "1.0.0")');
  }

  if (typeof config.manifestEndpoint !== 'string' || !config.manifestEndpoint) {
    errors.push('config.manifestEndpoint must be a non-empty string');
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
