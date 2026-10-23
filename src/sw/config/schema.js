import { STRATEGIES } from '../../shared/constants.js';

const VALID_STRATEGIES = new Set(Object.values(STRATEGIES));

const ALLOWED_ROUTE_KEYS = new Set([
  'match',
  'pattern',
  'params',
  'strategy',
  'origin',
  'networkTimeoutMs',
  'navigationFallback',
  'offlineFallback',
  'ignoreSearch',
  'throwOnFailure',
  'maxAge',
  'cacheOpaque',
  'options',
  'navigationAllowlist',
  'navigationDenylist',
  'ignoreURLParametersMatching',
  'directoryIndex',
  'cleanURLs',
  'plugins',
  'fallbackOn5xx',
  'onRevalidated',
  'cacheKeyWillBeUsed',
  'requestWillFetch',
  'cachedResponseWillBeUsed',
  'cacheWillUpdate',
  'fetchDidSucceed',
  'fetchDidFail',
  'cacheDidUpdate',
]);

const ALLOWED_CONFIG_KEYS = new Set([
  'version',
  'appVersion',
  'minVersion',
  'minSupportedVersion',
  'configPath',
  'updateAPI',
  'verifyHashes',
  'maxVerifyBytes',
  'allowOversizedUnverified',
  'skipVerifyGlobs',
  'caches',
  'snapshotCachePath',
  'precache',
  'routes',
  'defaultStrategy',
  'networkTimeoutMs',
  'updateTimeoutMs',
  'progressThrottleMs',
  'maxBackoffMs',
  'navigationFallback',
  'offlineFallback',
  'logLevel',
  'base',
  'retainPreviousVersionCache',
  'clearRuntimeOnUpdate',
  'cacheOpaque',
  'fallbackOn5xx',
  'throwOnFailure',
  'dev',
  'devBypass',
  'navigationPreload',
  'navigationAllowlist',
  'navigationDenylist',
  'ignoreURLParametersMatching',
  'directoryIndex',
  'cleanURLs',
  'plugins',
  'onPush',
  'onNotificationClick',
  'clearBadgeOnClick',
  'badging',
  'shareTarget',
  'share_target',
  'channel',
  'blockedVersions',
  'rolloutPercent',
  'publicKey',
  'signingKey',
  'respectSaveData',
  'maxUpdateBytes',
  'wifiOnlyThresholdBytes',
  'staging',
  'largeFileThresholdBytes',
  'applyMode',
  'telemetry',
  'probation',
  'cacheKeyWillBeUsed',
  'requestWillFetch',
  'cachedResponseWillBeUsed',
  'cacheWillUpdate',
  'fetchDidSucceed',
  'fetchDidFail',
  'cacheDidUpdate',
]);

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
    errors.push('config.configPath must be a string (e.g. "/api/update/config.json")');
  }

  // Validate updateAPI (object with { version, info } or array format)
  if (!config.updateAPI) {
    errors.push('config.updateAPI must be defined');
  } else if (Array.isArray(config.updateAPI)) {
    const hasVersion = config.updateAPI.some(e => e?.type === 'version' && typeof e?.endpoint === 'string' && e.endpoint);
    const hasInfo = config.updateAPI.some(e => e?.type === 'info' && typeof e?.endpoint === 'string' && e.endpoint);
    if (!hasVersion || !hasInfo) {
      errors.push('config.updateAPI array must include valid "version" and "info" endpoint entries');
    }
  } else if (typeof config.updateAPI === 'object') {
    if (typeof config.updateAPI.version !== 'string' || !config.updateAPI.version) {
      errors.push('config.updateAPI.version must be a non-empty string endpoint (e.g. "/api/update/version.json")');
    }
    if (typeof config.updateAPI.info !== 'string' || !config.updateAPI.info) {
      errors.push('config.updateAPI.info must be a non-empty string endpoint (e.g. "/api/update/info.json")');
    }
  } else {
    errors.push('config.updateAPI must be an object with { version, info } endpoints or an array of endpoint entries');
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      errors.push(`config.${key} is not a recognized configuration option.`);
    }
  }

  if (![ 'strict', 'warn', false ].includes(config.verifyHashes)) {
    errors.push("config.verifyHashes must be 'strict', 'warn' or false");
  }

  if (config.maxVerifyBytes !== undefined && (typeof config.maxVerifyBytes !== 'number' || config.maxVerifyBytes < 0)) {
    errors.push('config.maxVerifyBytes must be a non-negative number');
  }

  if (config.allowOversizedUnverified !== undefined && typeof config.allowOversizedUnverified !== 'boolean') {
    errors.push('config.allowOversizedUnverified must be a boolean');
  }

  if (config.skipVerifyGlobs !== undefined && (!Array.isArray(config.skipVerifyGlobs) || config.skipVerifyGlobs.some(g => typeof g !== 'string'))) {
    errors.push('config.skipVerifyGlobs must be an array of string glob patterns');
  }

  if (config.networkTimeoutMs !== undefined && (typeof config.networkTimeoutMs !== 'number' || config.networkTimeoutMs < 0)) {
    errors.push('config.networkTimeoutMs must be a non-negative number');
  }

  if (config.updateTimeoutMs !== undefined && (typeof config.updateTimeoutMs !== 'number' || config.updateTimeoutMs < 0)) {
    errors.push('config.updateTimeoutMs must be a non-negative number');
  }

  if (config.navigationFallback !== undefined && typeof config.navigationFallback !== 'string') {
    errors.push('config.navigationFallback must be a string');
  }

  if (config.offlineFallback !== undefined && typeof config.offlineFallback !== 'string') {
    errors.push('config.offlineFallback must be a string');
  }

  if (config.logLevel !== undefined && !['silent', 'error', 'warn', 'info', 'debug'].includes(config.logLevel)) {
    errors.push("config.logLevel must be 'silent', 'error', 'warn', 'info', or 'debug'");
  }

  if (!config.caches || typeof config.caches.offline !== 'string') {
    errors.push('config.caches.offline must be a string');
  }

  if (!config.caches || typeof config.caches.runtime !== 'string') {
    errors.push('config.caches.runtime must be a string');
  }

  if (config.caches && config.caches.meta !== undefined && typeof config.caches.meta !== 'string') {
    errors.push('config.caches.meta must be a string');
  }

  if (config.clearRuntimeOnUpdate !== undefined && typeof config.clearRuntimeOnUpdate !== 'boolean') {
    errors.push('config.clearRuntimeOnUpdate must be a boolean');
  }

  if (config.respectSaveData !== undefined && typeof config.respectSaveData !== 'boolean') {
    errors.push('config.respectSaveData must be a boolean');
  }

  if (config.maxUpdateBytes !== undefined && (typeof config.maxUpdateBytes !== 'number' || config.maxUpdateBytes < 0)) {
    errors.push('config.maxUpdateBytes must be a non-negative number');
  }

  if (config.wifiOnlyThresholdBytes !== undefined && (typeof config.wifiOnlyThresholdBytes !== 'number' || config.wifiOnlyThresholdBytes < 0)) {
    errors.push('config.wifiOnlyThresholdBytes must be a non-negative number');
  }

  if (config.staging !== undefined && (typeof config.staging !== 'object' || config.staging === null || Array.isArray(config.staging))) {
    errors.push('config.staging must be an object');
  }

  if (config.largeFileThresholdBytes !== undefined && (typeof config.largeFileThresholdBytes !== 'number' || config.largeFileThresholdBytes < 0)) {
    errors.push('config.largeFileThresholdBytes must be a non-negative number');
  }

  if (config.applyMode !== undefined && !['navigation', 'immediate'].includes(config.applyMode)) {
    errors.push("config.applyMode must be 'navigation' or 'immediate'");
  }

  if (config.telemetry !== undefined && typeof config.telemetry !== 'boolean' && (typeof config.telemetry !== 'object' || config.telemetry === null)) {
    errors.push('config.telemetry must be a boolean or an object');
  }

  if (config.probation !== undefined && typeof config.probation !== 'boolean' && (typeof config.probation !== 'object' || config.probation === null)) {
    errors.push('config.probation must be a boolean or an object');
  }

  if (!Array.isArray(config.precache)) {
    errors.push('config.precache must be an array of URL strings or pattern objects');
  } else {
    config.precache.forEach((item, i) => {
      if (
        typeof item !== 'string' &&
        (typeof item !== 'object' || item === null)
      ) {
        errors.push(`config.precache[${i}] must be a URL string or pattern object`);
      }
    });
  }

  if (!Array.isArray(config.routes)) {
    errors.push('config.routes must be an array');
  } else {
    config.routes.forEach((route, i) => {
      for (const key of Object.keys(route)) {
        if (!ALLOWED_ROUTE_KEYS.has(key)) {
          errors.push(`config.routes[${i}] has unrecognized option "${key}". Only canonical route options are supported.`);
        }
      }
      if (route.options && typeof route.options === 'object' && !Array.isArray(route.options)) {
        for (const optKey of Object.keys(route.options)) {
          if (!ALLOWED_ROUTE_KEYS.has(optKey) || optKey === 'options') {
            errors.push(`config.routes[${i}].options has unrecognized option "${optKey}".`);
          }
        }
      }
      const routePattern = route.pattern ?? route.match;
      if (
        typeof routePattern !== 'string' &&
        (typeof routePattern !== 'object' || routePattern === null)
      ) {
        errors.push(`config.routes[${i}].match (or pattern) must be a string or URLPattern object`);
      }
      if (!VALID_STRATEGIES.has(route.strategy)) {
        errors.push(
          `config.routes[${i}].strategy "${route.strategy}" is invalid. ` +
          `Valid: ${[...VALID_STRATEGIES].join(', ')}`
        );
      }
      if (route.networkTimeoutMs !== undefined && (typeof route.networkTimeoutMs !== 'number' || route.networkTimeoutMs < 0)) {
        errors.push(`config.routes[${i}].networkTimeoutMs must be a non-negative number`);
      }
      if (route.navigationFallback !== undefined && typeof route.navigationFallback !== 'string') {
        errors.push(`config.routes[${i}].navigationFallback must be a string`);
      }
      if (route.offlineFallback !== undefined && typeof route.offlineFallback !== 'string') {
        errors.push(`config.routes[${i}].offlineFallback must be a string`);
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
