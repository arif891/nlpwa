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

  // Validate updateAPI (object with { version, info } only)
  if (!config.updateAPI || typeof config.updateAPI !== 'object' || Array.isArray(config.updateAPI)) {
    errors.push('config.updateAPI must be an object with { version, info } endpoints');
  } else {
    if (typeof config.updateAPI.version !== 'string' || !config.updateAPI.version) {
      errors.push('config.updateAPI.version must be a non-empty string endpoint (e.g. "/api/update/version.json")');
    }
    if (typeof config.updateAPI.info !== 'string' || !config.updateAPI.info) {
      errors.push('config.updateAPI.info must be a non-empty string endpoint (e.g. "/api/update/info.json")');
    }
  }

  if (config.throwOfflineError !== undefined) {
    errors.push('config.throwOfflineError is deprecated. Use canonical "throwOnFailure" instead.');
  }

  if (![ 'strict', 'warn', false ].includes(config.verifyHashes)) {
    errors.push("config.verifyHashes must be 'strict', 'warn' or false");
  }

  if (config.maxVerifyBytes !== undefined && (typeof config.maxVerifyBytes !== 'number' || config.maxVerifyBytes < 0)) {
    errors.push('config.maxVerifyBytes must be a non-negative number');
  }

  if (!config.caches || typeof config.caches.offline !== 'string') {
    errors.push('config.caches.offline must be a string');
  }

  if (!config.caches || typeof config.caches.runtime !== 'string') {
    errors.push('config.caches.runtime must be a string');
  }

  if (config.clearRuntimeOnUpdate !== undefined && typeof config.clearRuntimeOnUpdate !== 'boolean') {
    errors.push('config.clearRuntimeOnUpdate must be a boolean');
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
      if (route.throwOfflineError !== undefined) {
        errors.push(`config.routes[${i}]: "throwOfflineError" is deprecated. Use canonical "throwOnFailure" instead.`);
      }
      if (route.maxAgeSeconds !== undefined || route.maxAgeMs !== undefined || route.ttl !== undefined) {
        errors.push(`config.routes[${i}]: "maxAgeSeconds", "maxAgeMs", and "ttl" are deprecated. Use canonical "maxAge" (duration string or ms) instead.`);
      }
      if (route.opaque !== undefined) {
        errors.push(`config.routes[${i}]: "opaque" is deprecated. Use canonical "cacheOpaque" instead.`);
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
