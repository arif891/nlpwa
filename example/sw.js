/* NLPWA Service Worker — https://github.com/arif891/nlpwa */
(function () {
  'use strict';

  /** Default cache storage names */
  const CACHE_NAMES = {
    OFFLINE: 'offline',
    RUNTIME: 'runtime',
    META:    'nlpwa-meta',
  };

  /** Path inside the offline cache where the snapshot is stored */
  const SNAPSHOT_CACHE_PATH = '/_nlpwa/snapshot.json';

  /** postMessage type identifiers (SW ↔ client) */
  const MESSAGE_TYPES = {
    UPDATE_READY:        'UPDATE_READY',        // SW → client: new version available
    CHECK_UPDATE:        'CHECK_UPDATE',        // client → SW: trigger manual check
    UPDATE_APPLIED:      'UPDATE_APPLIED',      // SW → client: broadcast to all windows when update is committed ({ version })
    NO_UPDATE:           'NO_UPDATE',           // SW → client: already up to date
    APPLY_UPDATE:        'APPLY_UPDATE',        // client → SW: switch to the staged update now
    APPLY_UPDATE_RESULT: 'APPLY_UPDATE_RESULT', // SW → client: 1-to-1 reply to APPLY_UPDATE ({ applied })
    GET_CACHE_INFO:      'GET_CACHE_INFO',      // client → SW: request storage quota & cache metrics
    CACHE_INFO:          'CACHE_INFO',          // SW → client: reply with quota & cache metrics
    CLEANUP_RUNTIME:     'CLEANUP_RUNTIME',     // client → SW: request runtime cache cleanup
    RUNTIME_CLEANED:     'RUNTIME_CLEANED',     // SW → client: reply with cleanup results
    UPDATE_FAILED:       'UPDATE_FAILED',       // SW → client: update staging or hash verification failed
    GET_VERSION:         'GET_VERSION',         // client → SW: request current active and staged version
    VERSION_INFO:        'VERSION_INFO',        // SW → client: reply with version info
    GET_STATUS:          'GET_STATUS',          // client → SW: request update status
    STATUS_INFO:         'STATUS_INFO',         // SW → client: reply with update status
    STAGING_PROGRESS:    'STAGING_PROGRESS',    // SW → client: progress during update staging
    PIN_CLIENT:          'PIN_CLIENT',          // client → SW: attach and pin this client to an active version
    CLIENT_PINNED:       'CLIENT_PINNED',       // SW → client: reply confirming client version pin
  };

  /** Runtime cache cleanup strategies */
  const CLEANUP_STRATEGIES = {
    LARGEST: 'largest', // Evict largest files first (or files above size threshold)
    LRU:     'lru',     // Evict oldest / least-recently-cached first
    MAX_AGE: 'max-age', // Evict files older than maxAgeMs
    QUOTA:   'quota',   // Evict when quota usage exceeds threshold
    PATTERN: 'pattern', // Evict files matching glob pattern
    ALL:     'all',     // Wipe all runtime cache entries
  };

  /** Max parallel downloads while staging an update. */
  const FETCH_CONCURRENCY = 6;

  /** Fetch strategy names */
  const STRATEGIES = {
    CACHE_FIRST:            'cache-first',
    NETWORK_FIRST:          'network-first',
    NETWORK_ONLY:           'network-only',
    STALE_WHILE_REVALIDATE: 'stale-while-revalidate',
    CACHE_ONLY:             'cache-only',
  };

  /**
   * Strategies that store responses in a cache.
   * Used by evict.js: a URL is only kept in cache if its matched route
   * uses one of these strategies.
   */
  const CACHING_CAPABLE_STRATEGIES = new Set([
    STRATEGIES.CACHE_FIRST,
    STRATEGIES.NETWORK_FIRST,
    STRATEGIES.STALE_WHILE_REVALIDATE,
    STRATEGIES.CACHE_ONLY,
  ]);

  /**
   * How many consecutive update checks may retry files that failed to download
   * before giving up until the next app version bump. Prevents a permanently
   * missing file (e.g. a typo in `precache`) from being retried forever.
   */
  const MAX_RETRY_ATTEMPTS = 5;

  /** Compiled regex cache — avoids recompiling the same glob on every fetch event */
  const MAX_REGEX_CACHE_SIZE = 100;
  const _regexCache = new Map();

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
  function globToRegex(pattern) {
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
  function matchGlob(pattern, url) {
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

  /**
   * Standard tracking query parameters stripped by default to avoid cache fragmentation.
   * Includes Google Analytics, Facebook, Microsoft Bing, HubSpot, Mailchimp, and generic ref.
   */
  const DEFAULT_IGNORE_SEARCH_PARAMS = [
    /^utm_/,
    /^fbclid$/,
    /^gclid$/,
    /^msclkid$/,
    /^dclid$/,
    /^_hsenc$/,
    /^_hsmi$/,
    /^ref$/,
    /^mc_cid$/,
    /^mc_eid$/,
  ];

  /**
   * Strip tracking query parameters matching ignoreURLParametersMatching patterns.
   *
   * @param {string|Request} requestOrUrl
   * @param {Array<string|RegExp>} [ignorePatterns]
   * @returns {string} clean URL string
   */
  function cleanTrackingParams(requestOrUrl, ignorePatterns = DEFAULT_IGNORE_SEARCH_PARAMS) {
    const urlStr = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
    let parsed;
    try {
      parsed = new URL(urlStr, 'http://localhost');
    } catch {
      return urlStr;
    }

    if (!parsed.search) return urlStr;
    if (!Array.isArray(ignorePatterns) || ignorePatterns.length === 0) return urlStr;

    let changed = false;
    const keys = [...parsed.searchParams.keys()];

    for (const key of keys) {
      for (const pattern of ignorePatterns) {
        const matches = pattern instanceof RegExp
          ? pattern.test(key)
          : pattern === key || matchGlob(pattern, key);
        if (matches) {
          parsed.searchParams.delete(key);
          changed = true;
          break;
        }
      }
    }

    if (!changed) return urlStr;

    if (typeof requestOrUrl === 'string' && !requestOrUrl.startsWith('http://') && !requestOrUrl.startsWith('https://')) {
      return parsed.pathname + (parsed.search ? parsed.search : '') + (parsed.hash ? parsed.hash : '');
    }

    return parsed.href;
  }

  /**
   * Default configuration values.
   * All fields are overridable by the user via initConfig(userConfig).
   */
  const DEFAULTS = {
    /**
     * Service Worker version — set MANUALLY by the developer.
     *
     * Bump this when you make structural changes to the SW itself:
     * routing logic, cache names, or fetch strategy implementations.
     *
     * Changing this triggers the browser's byte-level SW update. Upon activation,
     * NLPWA performs a force-refetch of all precache files into a separate staging cache
     * (bypassing local copies) and clears the runtime cache on commit, while active tabs
     * keep serving safely from the active cache until commit.
     *
     * Note: The APP version is NOT configured here — it is derived deterministically
     * from the manifest content hash (or set in config.json) and served via the update API endpoints.
     *
     * Example: '1', '2', 'v3'
     */
    version: '1',

    /**
     * Path to the runtime config.json file (stored in and read from offline cache).
     * Default: '/config.json'
     */
    configPath: '/config.json',

    /**
     * Server endpoints for two-tier update checks:
     * - version: lightweight check returning { version: 'x.y.z' }
     * - info: full manifest returning { version: 'x.y.z', files: [...] }
     */
    updateAPI: {
      version: '/api/update/version.json',
      info: '/api/update/info.json',
    },

    /**
     * How downloaded update files are checked against the manifest hash:
     *   'strict' - mismatch fails that file; the update is not applied until
     *              every file verifies (retried on the next check)
     *   'warn'   - mismatch is logged but the file is still stored
     *   false    - no verification
     * Use 'warn' only if a proxy/CDN rewrites your files after the build.
     */
    verifyHashes: 'strict',

    /**
     * Maximum file size in bytes for in-memory SHA-256 hash verification during staging.
     * Files larger than this threshold (e.g. WASM binaries, on-device AI models)
     * can skip in-memory clone & buffer to avoid memory spikes and crashes on low-end devices
     * if allowOversizedUnverified is set to true.
     * Default: 20 * 1024 * 1024 (20 MB)
     */
    maxVerifyBytes: 20 * 1024 * 1024,

    /**
     * Explicit opt-in to allow files larger than maxVerifyBytes to skip
     * in-memory SHA-256 verification in strict mode. Default: false.
     */
    allowOversizedUnverified: false,

    /**
     * Base public path for assets and API endpoints (e.g. '/my-app/' for subpaths).
     * Default: ''
     */
    base: '',

    /**
     * Keep immediate previous version cache after commit for multi-tab grace retention.
     * Default: true
     */
    retainPreviousVersionCache: true,

    /**
     * Clear the entire runtime cache whenever a new app version is committed.
     * Default: false
     */
    clearRuntimeOnUpdate: false,

    /**
     * Whether to cache opaque cross-origin responses in the runtime cache.
     * Default: false (prevents ~7MB Chrome quota padding per entry and prevents caching CDN 404s/500s).
     */
    cacheOpaque: false,

    /**
     * Enable Navigation Preload to begin fetching the navigation request in parallel with SW startup.
     * Accepts a boolean (true/false) or a custom header string (e.g. 'NLPWA-Preload').
     * Default: false
     */
    navigationPreload: false,

    /**
     * Navigation URL patterns allowed to receive the SPA shell fallback on navigation failure.
     * If non-empty, only matching navigations receive the fallback.
     * Default: []
     */
    navigationAllowlist: [],

    /**
     * Navigation URL patterns excluded from receiving the SPA shell fallback (e.g. ['/api/**', '/admin/**']).
     * Matching navigations will never receive the SPA shell fallback on failure.
     * Default: []
     */
    navigationDenylist: [],

    /**
     * Query parameters to strip when storing and matching cache keys to prevent cache fragmentation.
     * Matches RegExp patterns or glob strings (e.g. [/^utm_/, /^fbclid$/, 'gclid']).
     * Default: [/^utm_/, /^fbclid$/, /^gclid$/, /^msclkid$/, /^dclid$/, /^_hsenc$/, /^_hsmi$/, /^ref$/, /^mc_cid$/, /^mc_eid$/]
     */
    ignoreURLParametersMatching: DEFAULT_IGNORE_SEARCH_PARAMS,

    /**
     * Directory index filename to match when a URL path ends with a trailing slash.
     * Default: 'index.html'
     */
    directoryIndex: 'index.html',

    /**
     * Whether to match clean, extensionless URLs against .html files (e.g. /about -> /about.html).
     * Default: true
     */
    cleanURLs: true,

    /**
     * Enable development mode (bypasses Vite internal and HMR requests to network).
     * Default: false
     */
    dev: false,

    /** Explicitly bypass Vite dev server and HMR requests to network. Default: false */
    devBypass: false,

    /** Log level: 'silent' | 'error' | 'warn' | 'info' | 'debug'. Default: 'info' */
    logLevel: 'info',

    /**
     * Fallback URL for navigation requests when offline.
     * Default: '/index.html'
     */
    offlineFallback: '/index.html',

    /** Cache storage names */
    caches: {
      offline: CACHE_NAMES.OFFLINE,
      runtime: CACHE_NAMES.RUNTIME,
      meta: CACHE_NAMES.META,
    },

    /** Path inside the offline cache where the manifest snapshot is stored */
    snapshotCachePath: SNAPSHOT_CACHE_PATH,

    /**
     * Files to pre-cache at SW install time (the app shell).
     * These are fetched immediately when the SW installs.
     *
     * Keep this list small and focused strictly on the essential app shell (HTML, CSS, JS, icons).
     * Note: During update staging, hash verification clones and buffers each downloaded file
     * into memory to compute its SHA-256 digest before storing the original in CacheStorage.
     * Large precached files (videos, 3D models, heavy datasets) will double peak memory consumption
     * while hashing; serve them via runtime cache routes instead.
     */
    precache: [],

    /**
     * Per-URL-pattern fetch strategies.
     * Matched top-to-bottom; first match wins.
     * Patterns support glob syntax: * (segment) and ** (any path).
     *
     * Example:
     *   { match: '/api/**',    strategy: 'network-only' }
     *   { match: '/assets/**', strategy: 'cache-first' }
     */
    routes: [],

    /** Strategy to use when no route matches */
    defaultStrategy: STRATEGIES.NETWORK_FIRST,

    /**
     * Whether fetch failures should throw/reject instead of returning a synthetic 503 response.
     * Can also be set per route in routes: [{ match: '/api/**', strategy: 'network-only', throwOnFailure: true }].
     * Default: false (returns 503 response)
     */
    throwOnFailure: false,

    /**
     * Global plugins attached to all route strategies.
     * Supports: cacheWillUpdate, requestWillFetch, cachedResponseWillBeUsed,
     * fetchDidSucceed, fetchDidFail, cacheDidUpdate.
     * Default: []
     */
    plugins: [],
  };

  const VALID_STRATEGIES = new Set(Object.values(STRATEGIES));

  const ALLOWED_ROUTE_KEYS = new Set([
    'match',
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
    'configPath',
    'updateAPI',
    'verifyHashes',
    'maxVerifyBytes',
    'allowOversizedUnverified',
    'caches',
    'snapshotCachePath',
    'precache',
    'routes',
    'defaultStrategy',
    'networkTimeoutMs',
    'updateTimeoutMs',
    'navigationFallback',
    'offlineFallback',
    'logLevel',
    'base',
    'retainPreviousVersionCache',
    'clearRuntimeOnUpdate',
    'cacheOpaque',
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
  function validateConfig(config) {
    const errors = [];

    if (typeof config.version !== 'string' || !config.version) {
      errors.push('config.version must be a non-empty string (e.g. "1", "2", "v3")');
    }

    if (config.configPath && typeof config.configPath !== 'string') {
      errors.push('config.configPath must be a string (e.g. "/config.json")');
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

    if (!Array.isArray(config.precache)) {
      errors.push('config.precache must be an array of URL strings');
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
        if (typeof route.match !== 'string') {
          errors.push(`config.routes[${i}].match must be a string (glob pattern)`);
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

  const LOG_LEVELS = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
  };

  /**
   * Create a logger instance bound to a config accessor function.
   *
   * @param {Function} [getConfigFn]
   * @returns {{
   *   error: (...args: any[]) => void,
   *   warn: (...args: any[]) => void,
   *   log: (...args: any[]) => void,
   *   info: (...args: any[]) => void,
   *   debug: (...args: any[]) => void,
   * }}
   */
  function createLogger(getConfigFnOrLevel) {
    function getLevel() {
      try {
        if (typeof getConfigFnOrLevel === 'string' && getConfigFnOrLevel in LOG_LEVELS) {
          return LOG_LEVELS[getConfigFnOrLevel];
        }
        const config = typeof getConfigFnOrLevel === 'function' ? getConfigFnOrLevel() : getConfigFnOrLevel;
        const level = config?.logLevel;
        if (typeof level === 'string' && level in LOG_LEVELS) {
          return LOG_LEVELS[level];
        }
        return LOG_LEVELS.info;
      } catch {
        return LOG_LEVELS.info;
      }
    }

    return {
      error(...args) {
        if (getLevel() >= LOG_LEVELS.error) console.error(...args);
      },
      warn(...args) {
        if (getLevel() >= LOG_LEVELS.warn) console.warn(...args);
      },
      log(...args) {
        if (getLevel() >= LOG_LEVELS.info) console.log(...args);
      },
      info(...args) {
        if (getLevel() >= LOG_LEVELS.info) console.info(...args);
      },
      debug(...args) {
        if (getLevel() >= LOG_LEVELS.debug) console.debug(...args);
      },
    };
  }

  /**
   * Tiny "meta" cache + helpers that make updates atomic.
   *
   *   nlpwa-meta
   *     /_nlpwa/active.json  → { cache, version, swVersion }   which offline cache is live
   *     /_nlpwa/staged.json  → { cache, version, swVersion, complete, retryCount, evict, ... }
   *
   * Each app version lives in its own offline cache (`offline@<version>-<id>`).
   * An update is built in a new cache while the active one keeps serving; the
   * switch is a single atomic write to active.json.
   *
   * This module has no dependency on config so config/index.js can use it.
   */


  const logger$2 = createLogger();

  let META_CACHE = 'nlpwa-meta';

  /**
   * Configure the meta cache name (invoked during initConfig).
   * @param {string} name
   */
  function setMetaCacheName(name) {
    if (name && typeof name === 'string') {
      META_CACHE = name;
    }
  }

  const ACTIVE_KEY = '/_nlpwa/active.json';
  const STAGED_KEY = '/_nlpwa/staged.json';

  async function readMeta(key) {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match(key);
    if (!response) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function writeMeta(key, value) {
    const cache = await caches.open(META_CACHE);
    await cache.put(key, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  async function deleteMeta(key) {
    const cache = await caches.open(META_CACHE);
    await cache.delete(key);
  }

  // ── Active pointer (memoised: the SW can be restarted at any time, so the
  //    first read always comes from the meta cache) ─────────────────────────

  let _activePromise = null;

  function getActive() {
    if (!_activePromise) {
      _activePromise = (async () => {
        const record = await readMeta(ACTIVE_KEY).catch(() => null);
        if (!record || !record.cache) return null;

        // Pointer-validity check: verify that the cache referenced actually exists in CacheStorage
        // and is non-empty. If the browser evicted it, discard the stale pointer.
        try {
          if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
            const names = await caches.keys();
            if (!names.includes(record.cache)) {
              logger$2.warn(`[NLPWA] Active cache "${record.cache}" was evicted by the browser. Clearing stale active pointer.`);
              await deleteMeta(ACTIVE_KEY);
              return null;
            }
            const cache = await caches.open(record.cache);
            const keys = await cache.keys();
            if (keys.length === 0) {
              logger$2.warn(`[NLPWA] Active cache "${record.cache}" is empty (likely evicted by the browser). Clearing stale active pointer.`);
              await deleteMeta(ACTIVE_KEY);
              return null;
            }
            if (record.previousCache && !names.includes(record.previousCache)) {
              delete record.previousCache;
              await writeMeta(ACTIVE_KEY, record);
            }
          }
        } catch (err) {
          logger$2.warn('[NLPWA] Could not verify active cache validity:', err?.message || err);
        }
        return record;
      })().catch(() => {
        _activePromise = Promise.resolve(null);
        return null;
      });
    }
    return _activePromise;
  }

  async function getActiveName(baseName) {
    return (await getActive())?.cache ?? baseName;
  }

  async function openActive(baseName) {
    return caches.open(await getActiveName(baseName));
  }

  /** The single atomic commit point of an update. */
  async function setActive(record) {
    await writeMeta(ACTIVE_KEY, record);
    _activePromise = Promise.resolve(record);
  }

  // ── Staged update record (memoised to eliminate redundant CacheStorage reads) ─

  let _stagedPromise = null;

  function getStaged() {
    if (!_stagedPromise) {
      _stagedPromise = readMeta(STAGED_KEY).catch(() => {
        _stagedPromise = null;
        return null;
      });
    }
    return _stagedPromise;
  }

  async function setStaged(record) {
    await writeMeta(STAGED_KEY, record);
    _stagedPromise = Promise.resolve(record);
  }

  async function clearStaged() {
    await deleteMeta(STAGED_KEY);
    _stagedPromise = Promise.resolve(null);
  }

  // ── Per-client version pinning ─────────────────────────────────────────────
  // Maps clientId -> cacheName to guarantee runtime client isolation so that
  // an existing tab running unhashed code is never served assets from a newly
  // committed version after another tab commits.

  const PINS_KEY = '/_nlpwa/client-pins.json';
  const _clientPins = new Map();
  let _pinsLoaded = false;

  async function initClientPins() {
    if (_pinsLoaded) return;
    try {
      const stored = await readMeta(PINS_KEY);
      if (stored && typeof stored === 'object') {
        for (const [clientId, cacheName] of Object.entries(stored)) {
          if (typeof clientId === 'string' && typeof cacheName === 'string') {
            _clientPins.set(clientId, cacheName);
          }
        }
      }
    } catch {}
    _pinsLoaded = true;
  }

  function pinClient(clientId, cacheName) {
    if (!clientId || !cacheName) return;
    _clientPins.set(clientId, cacheName);
    _saveClientPins();
  }

  function getClientPinnedCache(clientId) {
    if (!clientId) return null;
    return _clientPins.get(clientId) || null;
  }

  function getAllPinnedCaches() {
    return Array.from(new Set(_clientPins.values()));
  }

  let _savePinsTimeout = null;
  function _saveClientPins() {
    if (_savePinsTimeout) return;
    _savePinsTimeout = setTimeout(async () => {
      _savePinsTimeout = null;
      try {
        const obj = Object.fromEntries(_clientPins);
        await writeMeta(PINS_KEY, obj);
      } catch {}
    }, 100);
  }

  async function _flushClientPins() {
    if (_savePinsTimeout) {
      clearTimeout(_savePinsTimeout);
      _savePinsTimeout = null;
    }
    try {
      const obj = Object.fromEntries(_clientPins);
      await writeMeta(PINS_KEY, obj);
    } catch {}
  }

  async function pruneClientPins() {
    const clientsObj = typeof self !== 'undefined' && self.clients ? self.clients : null;
    if (!clientsObj || typeof clientsObj.matchAll !== 'function') {
      return;
    }
    try {
      const clients = await clientsObj.matchAll({ includeUncontrolled: true, type: 'window' });
      const liveIds = new Set(clients.map((c) => c.id));
      let changed = false;
      for (const id of _clientPins.keys()) {
        if (!liveIds.has(id)) {
          _clientPins.delete(id);
          changed = true;
        }
      }
      if (changed) {
        await _flushClientPins();
      }
    } catch {}
  }

  // ── Cooperative lock ──────────────────────────────────────────────────────
  // Staging and committing must not overlap. Navigations must never wait for a
  // long download, so callers use tryAcquire() and simply skip when busy.

  let _busy = false;

  function tryAcquire() {
    if (_busy) return false;
    _busy = true;
    return true;
  }

  function release() {
    _busy = false;
  }

  /**
   * Execute an operation under the NLPWA operation lock.
   * Uses navigator.locks.request with ifAvailable: true across worker instances,
   * falling back to tryAcquire / release in memory.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {T|(() => T)} [fallback=false]
   * @returns {Promise<T>}
   */
  async function withLock(fn, fallback = false) {
    const getFallback = () => (typeof fallback === 'function' ? fallback() : fallback);

    const nav = typeof navigator !== 'undefined'
      ? navigator
      : typeof self !== 'undefined'
        ? self.navigator
        : null;

    if (nav?.locks?.request && typeof nav.locks.request === 'function') {
      try {
        return await nav.locks.request('nlpwa-operation-lock', { ifAvailable: true }, async (lock) => {
          if (!lock) return getFallback();
          if (!tryAcquire()) return getFallback();
          try {
            return await fn();
          } finally {
            release();
          }
        });
      } catch {
        // Fall through to in-memory locking if Web Locks throws or is unsupported
      }
    }

    if (!tryAcquire()) return getFallback();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Delete every offline cache that is neither in `keep` nor the runtime cache.
   * Managed names are the unversioned base cache (`base`) and versioned caches (`<base>@…`).
   *
   * @param {{ base: string, runtime: string, keep: Array<string|undefined> }} opts
   */
  async function cleanupCaches({ base, runtime, keep }) {
    const keepSet = new Set(keep.filter(Boolean));
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== runtime && name !== META_CACHE && !keepSet.has(name))
        .filter((name) => name === base || name.startsWith(`${base}@`))
        .map((name) => {
          logger$2.log(`[NLPWA] Removed old cache: ${name}`);
          return caches.delete(name);
        })
    );
  }

  /**
   * Fetch lightweight app version from the server (Tier 1 check).
   *
   * @returns {Promise<{ version: string }>}
   */
  async function fetchServerVersion() {
    const config = getConfig();
    const endpoints = getUpdateEndpoints();
    const versionEndpoint = endpoints.versionEndpoint;

    const baseTimeout = endpoints.timeoutMs ?? config.updateTimeoutMs ?? config.updateAPI?.timeoutMs ?? 15000;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && baseTimeout > 0
      ? AbortSignal.timeout(baseTimeout)
      : undefined;

    const response = await fetch(versionEndpoint, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`[NLPWA] Version check failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (typeof data.version !== 'string' || !data.version) {
      throw new Error('[NLPWA] Version check response missing valid "version"');
    }

    return data;
  }

  /**
   * Fetch the latest file tree update info from the server (Tier 2 fetch).
   * Always bypasses browser cache (cache: 'no-store') to get the true current state.
   *
   * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }>}
   */
  async function fetchServerInfo() {
    const config = getConfig();
    const endpoints = getUpdateEndpoints();
    const infoEndpoint = endpoints.infoEndpoint;

    const baseTimeout = endpoints.timeoutMs ?? config.updateTimeoutMs ?? config.updateAPI?.timeoutMs ?? 15000;
    const timeoutMs = baseTimeout > 0 ? baseTimeout * 2 : 0;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

    const response = await fetch(infoEndpoint, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`[NLPWA] Update info fetch failed: HTTP ${response.status} ${response.statusText}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(`[NLPWA] Update info response is not valid JSON (is the endpoint returning HTML?): ${err.message}`);
    }

    // Validate the expected shape before passing to computeDiff / applyDiff
    if (typeof data.version !== 'string' || !data.version) {
      throw new Error('[NLPWA] Update info missing or invalid "version" field (expected a non-empty string)');
    }
    if (!Array.isArray(data.files)) {
      throw new Error('[NLPWA] Update info missing "files" array');
    }

    return data;
  }

  /** Path of the snapshot entry inside an offline cache. */
  function getSnapshotPath() {
    return getConfig().snapshotCachePath;
  }

  let _activeSnapshotPaths = null;

  function getActiveSnapshotPaths() {
    return _activeSnapshotPaths;
  }

  function setActiveSnapshotPaths(paths) {
    _activeSnapshotPaths = paths ? (paths instanceof Set ? paths : new Set(paths)) : null;
  }

  /**
   * Load the snapshot (hash map of what is currently live) from the ACTIVE
   * offline cache. Returns null on a fresh install.
   *
   * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }|null>}
   */
  async function loadCachedSnapshot() {
    const cache = await openActive(getConfig().caches.offline);
    const response = await cache.match(getSnapshotPath());
    if (!response) {
      _activeSnapshotPaths = null;
      return null;
    }
    const data = await response.json();
    if (Array.isArray(data?.files)) {
      _activeSnapshotPaths = new Set(data.files.map((f) => f.path));
    }
    return data;
  }

  /**
   * Write a snapshot into a given offline cache. For a staged update this is the
   * LAST write: a cache that contains its snapshot is a complete one.
   *
   * @param {Cache} cache
   * @param {Object} snapshotData
   */
  async function writeSnapshot(cache, snapshotData) {
    const snapshot = { swVersion: getConfig().version, ...snapshotData };
    await cache.put(getSnapshotPath(), new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

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
  function resolvePathWithBase(path, base) {
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
  function resolveUpdateEndpoints(config = {}) {
    let versionEndpoint = '/api/update/version.json';
    let infoEndpoint = '/api/update/info.json';

    const updateAPI = config?.updateAPI ?? config;
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

  /** Singleton config instance, set by initConfig() */
  let _config = null;
  const logger$1 = createLogger(() => _config);

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
  function initConfig(userConfig = {}) {
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
      logger$1.error('[NLPWA] Config errors:\n' + errors.map(e => `  • ${e}`).join('\n'));
    }

    _config = Object.freeze(merged);
    return _config;
  }

  /**
   * Get the active config. Throws if initConfig() has not been called.
   *
   * @returns {typeof DEFAULTS}
   */
  function getConfig() {
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
  function updateActiveConfig(runtimeConfig = {}) {
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
  function ensureConfigReady() {
    if (!_configReadyPromise) {
      _configReadyPromise = loadConfigFromCache().catch((err) => {
        _configReadyPromise = null;
        logger$1.warn('[NLPWA] Config load failed, will retry:', err?.message || err);
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
  async function loadConfigFromCache() {
    const config = _config || initConfig();
    const baseName = config.caches?.offline || 'offline';
    const configPath = resolvePathWithBase(config.configPath || '/config.json', config.base);

    try {
      const cache = await openActive(baseName);
      const response = await cache.match(configPath);
      if (!response) {
        _configReadyPromise = Promise.resolve(null);
        return null;
      }

      const runtimeJson = await response.json();
      updateActiveConfig(runtimeJson);
      logger$1.log(`[NLPWA] Runtime config loaded from offline cache (${configPath})`);

      try {
        const snapRes = await cache.match('/_nlpwa/snapshot.json');
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
      logger$1.warn(`[NLPWA] Could not load config from offline cache: ${err.message}`);
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
  function getUpdateEndpoints() {
    return resolveUpdateEndpoints(getConfig());
  }

  const logger = createLogger(getConfig);

  /**
   * Compute the delta between a new server manifest and the currently cached one.
   *
   * The delta drives the update: only files that actually changed are fetched.
   * Because the server always returns the full file list, this automatically
   * handles any size of version jump (v1 → v100) in one pass.
   *
   * @param {Array<{ path: string, hash: string }>} newFiles   from server manifest
   * @param {Array<{ path: string, hash: string }>|null} oldFiles  from cached manifest
   *                                                               (null = fresh install)
   * @returns {{ added: string[], modified: string[], removed: string[] }}
   */
  function isSafePath(path) {
    if (typeof path !== 'string' || !path) return false;
    // Must start with a single forward slash and not be followed by / or \
    if (!/^\/(?![\/\\])/.test(path)) return false;
    // Reject absolute URLs with protocols (e.g. http:, https:, data:, javascript:)
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
    // Reject backslashes anywhere in path (prevent Windows/URL parser normalization quirks)
    if (path.includes('\\')) return false;
    // Reject path traversal with '..' segments
    if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) return false;
    return true;
  }

  function computeDiff(newFiles, oldFiles) {
    const safeNewFiles = (newFiles ?? []).filter(f => isSafePath(f?.path));
    const safeOldFiles = (oldFiles ?? []).filter(f => isSafePath(f?.path));

    // Build lookup maps for O(1) access
    const oldMap = new Map(safeOldFiles.map(f => [f.path, f.hash]));
    const newMap = new Map(safeNewFiles.map(f => [f.path, f.hash]));

    const added    = [];
    const modified = [];
    const removed  = [];

    // Files that are new or changed
    for (const [path, hash] of newMap) {
      if (!oldMap.has(path)) {
        added.push(path);
      } else if (oldMap.get(path) !== hash) {
        modified.push(path);
      }
      // hash unchanged → no action needed
    }

    // Files that exist in old manifest but are gone in new manifest
    for (const path of oldMap.keys()) {
      if (!newMap.has(path)) {
        removed.push(path);
      }
    }

    return { added, modified, removed };
  }

  /**
   * Extract size (bytes) and cached timestamp (ms) from a cached Response.
   *
   * @param {Response} res
   * @returns {Promise<{ size: number, cachedAt: number }>}
   */
  async function getResponseMetadata(res) {
    let size = 0;
    const sizeHeader = res.headers?.get('X-NLPWA-Content-Length') || res.headers?.get('Content-Length');
    if (sizeHeader) {
      const parsed = parseInt(sizeHeader, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) size = parsed;
    } else {
      try {
        const buf = await res.clone().arrayBuffer();
        size = buf.byteLength;
      } catch {
        size = 0;
      }
    }

    let cachedAt = 0;
    const cachedAtHeader = res.headers?.get('X-NLPWA-Cached-At');
    if (cachedAtHeader) {
      const parsed = parseInt(cachedAtHeader, 10);
      if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
    } else {
      const dateHeader = res.headers?.get('Date');
      if (dateHeader) {
        const parsed = new Date(dateHeader).getTime();
        if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
      }
    }

    return { size, cachedAt };
  }

  /**
   * Run an async mapper over items with bounded concurrency.
   *
   * @template T, R
   * @param {T[]} items
   * @param {number} limit
   * @param {(item: T, index: number) => Promise<R>} fn
   * @returns {Promise<R[]>}
   */
  async function mapConcurrent(items, limit, fn) {
    if (!items || items.length === 0) return [];
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Query current storage quota and runtime cache usage metrics.
   *
   * @returns {Promise<{
   *   quota: number|null,
   *   usage: number|null,
   *   percentUsed: number|null,
   *   remaining: number|null,
   *   runtimeEntries: number,
   *   runtimeBytes: number,
   *   largestEntries: Array<{ url: string, size: number, cachedAt: number }>
   * }>}
   */
  async function getStorageQuotaInfo() {
    let quota = null;
    let usage = null;
    let percentUsed = null;
    let remaining = null;

    const storage =
      (typeof self !== 'undefined' && self.navigator?.storage) ||
      (typeof navigator !== 'undefined' && navigator?.storage);

    if (storage && typeof storage.estimate === 'function') {
      try {
        const estimate = await storage.estimate();
        quota = estimate.quota ?? null;
        usage = estimate.usage ?? null;
        if (quota && usage != null) {
          percentUsed = Number(((usage / quota) * 100).toFixed(2));
          remaining = Math.max(0, quota - usage);
        }
      } catch {
        // Storage estimate not supported or denied
      }
    }

    const { caches: cacheNames } = getConfig();
    const cache = await caches.open(cacheNames.runtime);
    const requests = await cache.keys();

    let runtimeBytes = 0;
    const entries = [];

    const itemMetas = await mapConcurrent(requests, 6, async (req) => {
      const res = await cache.match(req);
      if (!res) return null;
      const meta = await getResponseMetadata(res);
      return {
        url: typeof req === 'string' ? req : req.url,
        size: meta.size,
        cachedAt: meta.cachedAt,
      };
    });

    for (const item of itemMetas) {
      if (item) {
        runtimeBytes += item.size;
        entries.push(item);
      }
    }

    // Top 5 largest entries
    const largestEntries = [...entries]
      .sort((a, b) => b.size - a.size)
      .slice(0, 5);

    return {
      quota,
      usage,
      percentUsed,
      remaining,
      runtimeEntries: requests.length,
      runtimeBytes,
      largestEntries,
    };
  }

  /**
   * Parse a size option accepting bytes, KB, MB, GB, or string (e.g. '50MB', '500KB').
   *
   * @param {number|string|undefined} bytesVal
   * @param {number|undefined} mbVal
   * @param {number|undefined} kbVal
   * @returns {number|null}
   */
  function resolveByteSize(bytesVal, mbVal, kbVal) {
    if (bytesVal != null) {
      if (typeof bytesVal === 'string') {
        const match = bytesVal.trim().match(/^([\d.]+)\s*(gb|mb|kb|b)?$/i);
        if (match) {
          const num = parseFloat(match[1]);
          const unit = (match[2] || 'b').toLowerCase();
          if (unit === 'gb') return Math.round(num * 1024 * 1024 * 1024);
          if (unit === 'mb') return Math.round(num * 1024 * 1024);
          if (unit === 'kb') return Math.round(num * 1024);
          return Math.round(num);
        }
      }
      const parsed = Number(bytesVal);
      return Number.isNaN(parsed) ? null : parsed;
    }
    if (mbVal != null) {
      const parsed = Number(mbVal);
      return Number.isNaN(parsed) ? null : Math.round(parsed * 1024 * 1024);
    }
    if (kbVal != null) {
      const parsed = Number(kbVal);
      return Number.isNaN(parsed) ? null : Math.round(parsed * 1024);
    }
    return null;
  }

  /**
   * Execute cleanup on the runtime cache using one or more strategies.
   *
   * Supported options:
   * - strategy: 'largest' | 'lru' | 'max-age' | 'quota' | 'pattern' | 'all' (default: 'lru')
   * - maxItemMB / maxItemKB / maxItemBytes / maxItem: evict any individual file larger than this limit
   * - minItemMB / minItemKB / minItemBytes / minItem: evict any individual file >= this limit
   * - maxTotalMB / maxTotalKB / maxTotalBytes / maxTotal: evict items until total runtime cache is <= limit
   * - maxEntries: evict items until total remaining count is <= limit
   * - maxAgeMs: evict items older than this age in ms
   * - match | pattern: glob pattern to match URLs to evict (for 'pattern' strategy)
   * - maxQuotaPercent: for 'quota' strategy, evict until usage percentage is <= this value (default: 80)
   * - maxQuotaMB / maxQuotaKB / maxQuotaBytes: for 'quota' strategy, evict until usage is <= limit
   * - preferLargest: for 'quota' strategy, evict largest entries first (default: true)
   * - count: limit number of items to evict
   *
   * @param {Object} [options]
   * @returns {Promise<{
   *   success: boolean,
   *   strategy: string,
   *   evictedCount: number,
   *   evictedUrls: string[],
   *   freedBytes: number,
   *   remainingEntries: number,
   *   remainingBytes: number,
   *   quota: Object
   * }>}
   */
  let _cleanupQueue = Promise.resolve();

  async function cleanRuntimeCache(options = {}) {
    const prev = _cleanupQueue;
    let runResolver;
    _cleanupQueue = new Promise((resolve) => { runResolver = resolve; });

    const run = async () => {
      const strategy = options.strategy || CLEANUP_STRATEGIES.LRU;

      const maxTotalBytes = resolveByteSize(options.maxTotalBytes ?? options.maxTotal, options.maxTotalMB, options.maxTotalKB);
      const maxItemBytes = resolveByteSize(options.maxItemBytes ?? options.maxItem, options.maxItemMB, options.maxItemKB);
      const minItemBytes = resolveByteSize(options.minItemBytes ?? options.minItem, options.minItemMB, options.minItemKB);
      const maxQuotaBytes = resolveByteSize(options.maxQuotaBytes ?? options.maxQuota, options.maxQuotaMB, options.maxQuotaKB);

      const { caches: cacheNames } = getConfig();
      const cache = await caches.open(cacheNames.runtime);
      const requests = await cache.keys();

      const allItems = [];
      let totalBytes = 0;

      const itemEntries = await mapConcurrent(requests, 6, async (req) => {
        const res = await cache.match(req);
        if (!res) return null;
        const meta = await getResponseMetadata(res);
        return {
          req,
          url: typeof req === 'string' ? req : req.url,
          size: meta.size,
          cachedAt: meta.cachedAt,
        };
      });

      for (const item of itemEntries) {
        if (item) {
          totalBytes += item.size;
          allItems.push(item);
        }
      }

      const toEvictSet = new Set();
      let remainingBytes = totalBytes;

      const markForEviction = (item) => {
        if (!toEvictSet.has(item)) {
          toEvictSet.add(item);
          remainingBytes = Math.max(0, remainingBytes - item.size);
        }
      };

    // 1. Filter: individual item size thresholds
    if (maxItemBytes != null) {
      for (const item of allItems) {
        if (item.size > maxItemBytes) {
          markForEviction(item);
        }
      }
    }
    if (minItemBytes != null) {
      for (const item of allItems) {
        if (item.size >= minItemBytes) {
          markForEviction(item);
        }
      }
    }

    // 2. Filter: individual max age / TTL
    if (options.maxAgeMs != null && strategy !== CLEANUP_STRATEGIES.MAX_AGE) {
      const cutoff = Date.now() - options.maxAgeMs;
      for (const item of allItems) {
        if (item.cachedAt > 0 && item.cachedAt < cutoff) {
          markForEviction(item);
        }
      }
    }

    // 3. Strategy evaluation on remaining items
    const candidates = allItems.filter(item => !toEvictSet.has(item));

    if (strategy === CLEANUP_STRATEGIES.ALL) {
      for (const item of candidates) {
        markForEviction(item);
      }
    } else if (strategy === CLEANUP_STRATEGIES.PATTERN) {
      const pattern = options.match || options.pattern;
      if (pattern) {
        for (const item of candidates) {
          if (matchGlob(pattern, item.url)) {
            markForEviction(item);
          }
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.MAX_AGE) {
      const maxAgeMs = options.maxAgeMs ?? (7 * 24 * 60 * 60 * 1000); // 7 days default
      const cutoff = Date.now() - maxAgeMs;
      for (const item of candidates) {
        if (item.cachedAt > 0 && item.cachedAt < cutoff) {
          markForEviction(item);
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.LARGEST) {
      // Sort descending by size (largest files first)
      candidates.sort((a, b) => b.size - a.size);

      let currentRemainingCount = allItems.length - toEvictSet.size;

      for (const item of candidates) {
        const needsSizeEviction = maxTotalBytes != null && remainingBytes > maxTotalBytes;
        const needsCountEviction = options.maxEntries != null && currentRemainingCount > options.maxEntries;
        const hitLimit = options.count != null && toEvictSet.size >= options.count;

        if (hitLimit) break;
        if (needsSizeEviction || needsCountEviction) {
          markForEviction(item);
          currentRemainingCount--;
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.LRU) {
      // Sort ascending by cachedAt (oldest first)
      candidates.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));

      let currentRemainingCount = allItems.length - toEvictSet.size;

      for (const item of candidates) {
        const needsCountEviction = options.maxEntries != null && currentRemainingCount > options.maxEntries;
        const needsSizeEviction = maxTotalBytes != null && remainingBytes > maxTotalBytes;
        const hitLimit = options.count != null && toEvictSet.size >= options.count;

        if (hitLimit) break;
        if (needsCountEviction || needsSizeEviction) {
          markForEviction(item);
          currentRemainingCount--;
        }
      }
    } else if (strategy === CLEANUP_STRATEGIES.QUOTA) {
      const quotaInfo = await getStorageQuotaInfo();
      const maxQuotaPercent = options.maxQuotaPercent ?? 80;

      let currentUsage = quotaInfo.usage ?? totalBytes;
      const quota = quotaInfo.quota;

      const isOverQuota = () => {
        if (quota && maxQuotaPercent != null) {
          if ((currentUsage / quota) * 100 > maxQuotaPercent) return true;
        }
        if (maxQuotaBytes != null && currentUsage > maxQuotaBytes) return true;
        return false;
      };

      if (isOverQuota()) {
        // By default prefer evicting largest files to recover quota fastest
        if (options.preferLargest !== false) {
          candidates.sort((a, b) => b.size - a.size);
        } else {
          candidates.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
        }

        for (const item of candidates) {
          if (!isOverQuota()) break;
          markForEviction(item);
          currentUsage = Math.max(0, currentUsage - item.size);
        }
      }
    }

    // 4. Perform deletions
    const evicted = [...toEvictSet];
    let freedBytes = 0;

    await mapConcurrent(evicted, 8, async (item) => {
      freedBytes += item.size;
      await cache.delete(item.req);
    });

    const finalRemainingEntries = allItems.length - evicted.length;
    const finalRemainingBytes = Math.max(0, totalBytes - freedBytes);
    const updatedQuota = await getStorageQuotaInfo();

    logger.log(
      `[NLPWA] Runtime cache cleaned (${strategy}): ${evicted.length} evicted, ` +
      `${(freedBytes / 1024).toFixed(1)} KB freed, ${finalRemainingEntries} remaining`
    );

    return {
      success: true,
      strategy,
      evictedCount: evicted.length,
      evictedUrls: evicted.map(item => item.url),
      freedBytes,
      remainingEntries: finalRemainingEntries,
      remainingBytes: finalRemainingBytes,
      quota: updatedQuota,
    };
    };

    try {
      await prev.catch(() => {});
      return await run();
    } finally {
      runResolver();
    }
  }

  /**
   * SHA-256 of a buffer as a lowercase hex string.
   * Works in Service Workers, browsers and Node 18+ (Web Crypto).
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {Promise<string>}
   */
  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Compare a full SHA-256 hex digest with a manifest hash.
   *
   * The CLI emits the first 32 hex characters, so the manifest hash is treated
   * as a prefix of the full digest. Anything shorter than 32 characters is rejected
   * so a truncated or empty hash can never "match" by accident.
   *
   * @param {string} actualHex  full digest from sha256Hex()
   * @param {string} expected   hash from the manifest (prefix of the digest, min 32 chars)
   * @returns {boolean}
   */
  function hashMatches(actualHex, expected) {
    if (typeof expected !== 'string' || expected.length < 32) return false;
    return actualHex.startsWith(expected.toLowerCase());
  }

  /** Run `fn` over `items` with at most `limit` in flight. */
  async function mapLimit(items, limit, fn) {
    let next = 0;
    // JavaScript runtimes are single-threaded; next++ evaluates synchronously before
    // any microtask yield in `await fn(...)`, ensuring workers never claim the same item.
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx]);
      }
    });
    await Promise.all(workers);
  }

  /** Is `path` already in the staging cache with the expected content? */
  async function isAlreadyStaged(cacheOrOptions, path, expected, verify, maxVerifyBytes = 20 * 1024 * 1024, fileSize = null, fetchUrl = path, allowOversizedUnverified = false) {
    let cache = cacheOrOptions;
    if (cacheOrOptions && typeof cacheOrOptions === 'object' && !('match' in cacheOrOptions) && 'cache' in cacheOrOptions) {
      ({
        cache,
        path,
        expected,
        verify,
        maxVerifyBytes = 20 * 1024 * 1024,
        fileSize = null,
        fetchUrl = path,
        allowOversizedUnverified = false,
      } = cacheOrOptions);
    }
    const hit = (await cache.match(fetchUrl)) || (fetchUrl !== path ? await cache.match(path) : null);
    if (!hit) return false;
    if (!expected || verify === false) return true;
    const size = fileSize ?? Number(hit.headers?.get?.('content-length') || hit.headers?.get?.('x-nlpwa-content-length') || 0);
    if (maxVerifyBytes > 0 && size > maxVerifyBytes) {
      if (allowOversizedUnverified || verify === 'warn') {
        return true;
      }
    }
    return hashMatches(await sha256Hex(await hit.arrayBuffer()), expected);
  }

  /** Fetch a file fresh from the network and check it against its manifest hash. */
  async function fetchVerified(pathOrOptions, expected, verify, maxVerifyBytes = 20 * 1024 * 1024, fileSize = null, allowOversizedUnverified = false) {
    let path = pathOrOptions;
    if (pathOrOptions && typeof pathOrOptions === 'object' && 'path' in pathOrOptions) {
      ({
        path,
        expected,
        verify,
        maxVerifyBytes = 20 * 1024 * 1024,
        fileSize = null,
        allowOversizedUnverified = false,
      } = pathOrOptions);
    }
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(30000)
      : undefined;
    const response = await fetch(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    if (expected && verify !== false) {
      const size = fileSize ?? Number(response.headers?.get?.('content-length') || response.headers?.get?.('x-nlpwa-content-length') || 0);
      if (maxVerifyBytes > 0 && size > maxVerifyBytes) {
        if (allowOversizedUnverified || verify === 'warn') {
          logger.warn(
            `[NLPWA] ${path}: File size (${(size / (1024 * 1024)).toFixed(1)} MB) exceeds maxVerifyBytes threshold ` +
            `(${(maxVerifyBytes / (1024 * 1024)).toFixed(1)} MB). Skipping in-memory hash verification (opt-in allowOversizedUnverified).`
          );
          return response;
        }
      }
      const actual = await sha256Hex(await response.clone().arrayBuffer());
      if (!hashMatches(actual, expected)) {
        const detail = `hash mismatch (expected ${expected}, got ${actual.slice(0, expected.length)})`;
        if (verify === 'strict') throw new Error(detail);
        logger.warn(`[NLPWA] ${path}: ${detail} - storing anyway (verifyHashes: 'warn')`);
      }
    }
    return response;
  }

  /**
   * Build the new app version in a SEPARATE cache while the active one keeps
   * serving. Nothing here is visible to the running app until commitStaged().
   *
   * For every file in the manifest:
   *   1. already in the staging cache and verified  → reuse   (resume after failure)
   *   2. unchanged since the active version         → copy locally, no network
   *   3. otherwise                                  → fetch (no-store) and verify hash
   *
   * The snapshot is written last: a staging cache that contains its snapshot is
   * complete. If any file fails to download or verify, the update is never
   * finalized or committed (strict atomicity). Verified files are preserved in the
   * staging cache so subsequent checks can resume, entering exponential backoff
   * after MAX_RETRY_ATTEMPTS while the running app stays 100% untouched.
   *
   * @param {{ version: string, files: Array<{ path: string, hash: string }> }} manifest
   * @param {{ activeSnapshot?: Object|null, forceRefetch?: boolean }} [opts]
   *        forceRefetch: ignore the active copies and download everything (SW engine change)
   * @returns {Promise<
   *   { status: 'ready', failed: string[], reused: number, copied: number, fetched: number } |
   *   { status: 'incomplete', failed: string[], retryCount: number }
   * >}
   */
  async function stageUpdate(manifest, { activeSnapshot = null, forceRefetch = false } = {}) {
    const config = getConfig();
    const verify = config.verifyHashes ?? 'strict';
    const maxVerifyBytes = config.maxVerifyBytes ?? (20 * 1024 * 1024);
    const allowOversizedUnverified = Boolean(config.allowOversizedUnverified);
    const files = manifest.files.filter((f) => isSafePath(f?.path));

    const diff = computeDiff(files, activeSnapshot?.files ?? null);
    const evict = [...diff.modified, ...diff.removed];

    // ── Resume a matching partial staging cache, or start a new one ──────────
    let staged = await getStaged();
    const resumable = staged && !staged.complete
      && staged.version === manifest.version && staged.swVersion === config.version;
    if (!resumable) {
      if (staged?.cache) await caches.delete(staged.cache);
      staged = {
        cache: `${config.caches.offline}@${manifest.version}-${Date.now().toString(36)}`,
        version: manifest.version,
        swVersion: config.version,
        complete: false,
        retryCount: 0,
      };
    }
    // Record the staging cache BEFORE creating it so a crash can never orphan it
    await setStaged(staged);

    const next = await caches.open(staged.cache);
    const activeCache = activeSnapshot ? await openActive(config.caches.offline) : null;
    const activeHashes = new Map((activeSnapshot?.files ?? []).map((f) => [f.path, f.hash]));

    const stats = { reused: 0, copied: 0, fetched: 0 };
    const failed = [];
    const failedDetails = {};

    const putWithQuotaRecovery = async (path, res) => {
      const retryCopy = res.clone();
      try {
        await next.put(path, res);
      } catch (err) {
        const isQuota = err.name === 'QuotaExceededError' || /quota/i.test(err.message || '');
        if (isQuota) {
          logger.warn(`[NLPWA] QuotaExceededError while staging ${path}. Freeing runtime cache space...`);
          const cleaned = await cleanRuntimeCache({ strategy: 'all' }).catch(() => null);
          if (cleaned && (cleaned.freedBytes > 0 || cleaned.evictedCount > 0)) {
            await next.put(path, retryCopy);
            return;
          }
        }
        throw err;
      }
    };

    let processedCount = 0;
    const totalFiles = files.length;
    const notifyProgress = (filePath) => {
      processedCount++;
      if (activeSnapshot && typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
        self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
          const rawPercent = totalFiles > 0 ? Math.floor((processedCount / totalFiles) * 100) : 100;
          const percent = processedCount >= totalFiles ? 100 : Math.min(99, rawPercent);
          clients.forEach((c) => c.postMessage({
            type: MESSAGE_TYPES.STAGING_PROGRESS,
            version: manifest.version,
            loaded: processedCount,
            total: totalFiles,
            percent,
            file: filePath,
          }));
        }).catch(() => {});
      }
    };

    await mapLimit(files, FETCH_CONCURRENCY, async ({ path, hash, size }) => {
      const fetchUrl = resolvePathWithBase(path, config.base);
      try {
        if (await isAlreadyStaged(next, path, hash, verify, maxVerifyBytes, size, fetchUrl, allowOversizedUnverified)) {
          stats.reused++;
          notifyProgress(path);
          return;
        }
        if (!forceRefetch && activeCache && hash && activeHashes.get(path) === hash) {
          const hit = (await activeCache.match(fetchUrl)) || (fetchUrl !== path ? await activeCache.match(path) : null);
          if (hit) {
            const copyForPath = fetchUrl !== path ? hit.clone() : null;
            await putWithQuotaRecovery(fetchUrl, hit);
            if (copyForPath) {
              await putWithQuotaRecovery(path, copyForPath);
            }
            stats.copied++;
            notifyProgress(path);
            return;
          }
        }
        const fetchedRes = await fetchVerified(fetchUrl, hash, verify, maxVerifyBytes, size, allowOversizedUnverified);
        const copyForPath = fetchUrl !== path ? fetchedRes.clone() : null;
        await putWithQuotaRecovery(fetchUrl, fetchedRes);
        if (copyForPath) {
          await putWithQuotaRecovery(path, copyForPath);
        }
        stats.fetched++;
        notifyProgress(path);
      } catch (err) {
        failed.push(path);
        failedDetails[path] = err.message;
        notifyProgress(path);
        logger.warn(`[NLPWA] Staging failed: ${fetchUrl} - ${err.message}`);
      }
    });

    const retryCount = failed.length ? staged.retryCount + 1 : 0;

    if (failed.length > 0) {
      // True all-or-nothing atomicity: never finalize or commit a partial or broken update.
      // Keep verified files in the staging cache so subsequent checks can resume.
      // Active cache remains 100% pure and untouched.
      const prevFailed = staged.failedFiles ?? [];
      const isSameFiles = prevFailed.length > 0
        && failed.length === prevFailed.length
        && failed.every((f) => prevFailed.includes(f));

      const hasHashMismatch = Object.values(failedDetails).some(
        (msg) => typeof msg === 'string' && msg.includes('hash mismatch')
      );
      const hasQuotaExceeded = Object.values(failedDetails).some(
        (msg) => typeof msg === 'string' && (msg.includes('QuotaExceededError') || /quota/i.test(msg))
      );

      let nextRetryAt = null;
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        const backoffMs = Math.min(60000 * Math.pow(2, Math.min(retryCount - MAX_RETRY_ATTEMPTS, 6)), 3600000);
        nextRetryAt = Date.now() + backoffMs;
        logger.warn(
          `[NLPWA] Staging incomplete: ${failed.length} file(s) failed after ${retryCount} attempts: ` +
          `${failed.join(', ')}. Active version remains live.`
        );
      }

      if (isSameFiles && retryCount >= 2) {
        if (hasHashMismatch) {
          logger.error(
            `[NLPWA] Persistent hash mismatch on ${failed.join(', ')} across ${retryCount} attempts. ` +
            `A CDN, proxy, or host minification may be altering file contents in transit. ` +
            `Consider setting verifyHashes: 'warn' or false in your nlpwa config if this transformation is expected.`
          );
        } else {
          logger.warn(
            `[NLPWA] Repeated staging failure on the same file(s): ${failed.join(', ')} (${retryCount} attempts).`
          );
        }
      }

      await setStaged({
        ...staged,
        retryCount,
        failedFiles: failed,
        failedDetails,
        nextRetryAt,
        complete: false,
      });

      return {
        status: 'incomplete',
        failed,
        failedDetails,
        retryCount,
        nextRetryAt,
        persistent: Boolean(isSameFiles && retryCount >= 2),
        hasHashMismatch: Boolean(hasHashMismatch),
        quotaExceeded: Boolean(hasQuotaExceeded),
      };
    }

    // ── Finalise: snapshot last, then mark the staged record complete ────────
    await writeSnapshot(next, {
      version: manifest.version,
      files,
    });

    await setStaged({
      ...staged,
      retryCount: 0,
      failedFiles: [],
      failedDetails: {},
      nextRetryAt: null,
      complete: true,
      evict,
      clearRuntime: forceRefetch,
    });

    logger.log(
      `[NLPWA] Staged v${manifest.version}: ${stats.fetched} fetched, ${stats.copied} copied, ` +
      `${stats.reused} reused`
    );

    return { status: 'ready', failed: [], ...stats };
  }

  // ── Offline cache helpers ────────────────────────────────────────────────────

  /**
   * Match a request against a cache with standard HTML, clean URLs, directory index, and base path aliases.
   *
   * @param {Cache} cache
   * @param {Request|string} request
   * @param {CacheQueryOptions} [matchOptions]
   * @param {string} [base]
   * @param {Object} [config]
   * @returns {Promise<Response|undefined>}
   */
  async function matchWithAliases(cache, request, matchOptions, base, config = getConfig()) {
    const rawUrl = typeof request === 'string' ? request : request.url;
    const ignorePatterns = config?.ignoreURLParametersMatching;
    const cleanedUrl = cleanTrackingParams(rawUrl, ignorePatterns);

    let hit = await cache.match(request, matchOptions);
    if (!hit && cleanedUrl !== rawUrl) {
      hit = await cache.match(cleanedUrl, matchOptions);
    }
    if (hit) return hit;

    let pathname = null;
    try {
      pathname = new URL(cleanedUrl, 'https://example.com').pathname;
    } catch {}

    if (!pathname) return undefined;

    const directoryIndex = config?.directoryIndex ?? 'index.html';
    const cleanIndex = directoryIndex.startsWith('/') ? directoryIndex.slice(1) : directoryIndex;
    const cleanURLs = config?.cleanURLs !== false;

    // 1. Root / Directory index
    if (directoryIndex) {
      if (pathname === '/') {
        hit = await cache.match(`/${cleanIndex}`, matchOptions);
        if (hit) return hit;
      } else if (pathname === `/${cleanIndex}`) {
        hit = await cache.match('/', matchOptions);
        if (hit) return hit;
      } else if (pathname.endsWith('/')) {
        hit = await cache.match(`${pathname}${cleanIndex}`, matchOptions);
        if (hit) return hit;
      }
    }

    // 2. Clean URLs (e.g. /about -> /about.html)
    if (cleanURLs) {
      const lastSegment = pathname.split('/').pop() || '';
      if (lastSegment && !lastSegment.includes('.')) {
        hit = await cache.match(`${pathname}.html`, matchOptions);
        if (hit) return hit;
      }
    }

    // 3. Subpath base aliases
    if (base) {
      const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
      if (pathname === cleanBase || pathname === `${cleanBase}/`) {
        return (await cache.match(`${cleanBase}/${cleanIndex}`, matchOptions))
          ?? (await cache.match(`/${cleanIndex}`, matchOptions))
          ?? (await cache.match(cleanBase, matchOptions))
          ?? (await cache.match(`${cleanBase}/`, matchOptions));
      }
      if (pathname === `${cleanBase}/${cleanIndex}`) {
        return (await cache.match(`${cleanBase}/`, matchOptions))
          ?? (await cache.match(cleanBase, matchOptions))
          ?? (await cache.match(`/${cleanIndex}`, matchOptions));
      }
    }
    return undefined;
  }

  /**
   * Read a response from the offline (app shell) cache.
   *
   * @param {Request|string} request
   * @param {CacheQueryOptions} [matchOptions]
   * @returns {Promise<Response|undefined>}
   */
  async function getFromOffline(request, matchOptions, clientId = null) {
    const config = getConfig();
    const { caches: cacheNames, retainPreviousVersionCache, base } = config;

    let cache;
    const pinnedName = clientId ? getClientPinnedCache(clientId) : null;
    if (pinnedName) {
      try {
        cache = await caches.open(pinnedName);
      } catch {
        cache = await openActive(cacheNames.offline);
      }
    } else {
      cache = await openActive(cacheNames.offline);
    }

    let hit = await matchWithAliases(cache, request, matchOptions, base, config);

    if (!hit && retainPreviousVersionCache) {
      const active = await getActive();
      if (active?.previousCache && active.previousCache !== pinnedName) {
        try {
          const prev = await caches.open(active.previousCache);
          hit = await matchWithAliases(prev, request, matchOptions, base, config);
        } catch {
          // previous cache may have been removed
        }
      }
    }
    return hit;
  }

  // ── Runtime cache helpers ────────────────────────────────────────────────────

  /**
   * Read a response from the runtime (lazy) cache.
   *
   * @param {Request|string} request
   * @param {CacheQueryOptions} [matchOptions]
   * @returns {Promise<Response|undefined>}
   */
  async function getFromRuntime(request, matchOptions) {
    const config = getConfig();
    const { caches: cacheNames, base } = config;
    const cache = await caches.open(cacheNames.runtime);
    return matchWithAliases(cache, request, matchOptions, base, config);
  }

  /**
   * Write a response into the runtime cache.
   * Used by fetch strategies (network-first, stale-while-revalidate, cache-first).
   *
   * @param {Request|string} request
   * @param {Response} response
   */
  async function putInRuntime(request, response) {
    const config = getConfig();
    const { caches: cacheNames, ignoreURLParametersMatching } = config;
    const cache = await caches.open(cacheNames.runtime);

    let responseToStore = response.clone();
    if (response.type !== 'opaque') {
      try {
        const isNullBody = [101, 204, 205, 304].includes(response.status);
        const headers = new Headers(response.headers);
        if (!headers.has('X-NLPWA-Cached-At')) {
          headers.set('X-NLPWA-Cached-At', String(Date.now()));
        }
        if (isNullBody) {
          headers.set('X-NLPWA-Content-Length', '0');
          responseToStore = new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
          await cache.put(request, responseToStore);
          return;
        }
        if (!headers.has('X-NLPWA-Content-Length')) {
          const cl = headers.get('Content-Length');
          if (cl) {
            headers.set('X-NLPWA-Content-Length', cl);
          }
        }
        responseToStore = new Response(responseToStore.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        responseToStore = response.clone();
      }
    }

    await cache.put(request, responseToStore);

    const rawUrl = typeof request === 'string' ? request : request.url;
    const cleanedUrl = cleanTrackingParams(rawUrl, ignoreURLParametersMatching);
    if (cleanedUrl !== rawUrl) {
      await cache.put(cleanedUrl, responseToStore.clone()).catch(() => {});
    }
  }

  /**
   * Delete specific URLs from the runtime cache.
   * Used during update to evict stale/changed files so they are re-fetched fresh.
   *
   * @param {string[]} paths  URL pathnames to evict, e.g. ['/app.js', '/pages/about.html']
   */
  async function evictFromRuntime(paths) {
    if (!paths.length) return;
    const { caches: cacheNames, base } = getConfig();
    const cache = await caches.open(cacheNames.runtime);
    await Promise.all(
      paths.flatMap((path) => {
        const ops = [cache.delete(path)];
        if (base) {
          ops.push(cache.delete(resolvePathWithBase(path, base)));
        }
        return ops;
      })
    );
  }

  /**
   * Convenience: look up a request from offline first, then runtime.
   * Returns the first match found, or undefined if neither has it.
   *
   * @param {Request|string} request
   * @returns {Promise<Response|undefined>}
   */
  async function getFromCache(request, matchOptions, clientId = null) {
    return (await getFromOffline(request, matchOptions, clientId)) ?? (await getFromRuntime(request, matchOptions));
  }

  /**
   * Cache status values added to responses via the X-Cache-Status header.
   *
   * Clients can read this header from any intercepted response to determine
   * where the response actually came from:
   *
   *   fetch('/app.js').then(r => console.log(r.headers.get('X-Cache-Status')));
   *   // → 'offline-cache' | 'runtime-cache' | 'network' | 'stale' | 'offline-fallback'
   */
  const CACHE_STATUS = {
    /** Response was fetched fresh from the network */
    NETWORK:          'network',

    /** Response came from parallel navigation preload */
    PRELOAD:          'preload',

    /** Response came from the offline (precache / app shell) store */
    OFFLINE_CACHE:    'offline-cache',

    /** Response came from the runtime (lazy) cache */
    RUNTIME_CACHE:    'runtime-cache',

    /** Stale-while-revalidate: served from cache while network update runs in background */
    STALE:            'stale',

    /** Synthetic 503: no network and no cached version available */
    OFFLINE_FALLBACK: 'offline-fallback',

    /** Request bypassed the Service Worker cache */
    BYPASS:           'bypass',
  };

  /** Name of the response header injected by the SW */
  const CACHE_STATUS_HEADER = 'X-Cache-Status';

  /**
   * Wrap a Response with an X-Cache-Status header indicating its origin.
   *
   * Notes:
   *   - Response headers are immutable, so a new Response is constructed.
   *   - Opaque responses (cross-origin, no CORS) cannot have their body read,
   *     so they are returned as-is with no header added.
   *   - The original response is consumed — do not use it after calling this.
   *
   * @param {Response} response
   * @param {string}   status    one of CACHE_STATUS values
   * @returns {Response}
   */
  function tagResponse(response, status) {
    if (!response) return response;

    // Opaque responses (opaque / opaqueredirect / status 0) cannot have their body
    // read or reconstructed without throwing RangeError. Return them unchanged.
    if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set(CACHE_STATUS_HEADER, status);

    const tagged = new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    });

    if (response.url) {
      try {
        Object.defineProperty(tagged, 'url', { value: response.url });
      } catch {
        // ignore in environments that do not permit defining url
      }
    }

    if (response.redirected) {
      try {
        Object.defineProperty(tagged, 'redirected', { value: response.redirected });
      } catch {
        // ignore
      }
    }

    return tagged;
  }

  /**
   * RFC 7233 / RFC 9110 Range request helper.
   *
   * Slices a cached 200 OK response to produce an HTTP 206 Partial Content response.
   * Safari on iOS and macOS requires Range request support for <audio> and <video> playback.
   *
   * @param {Request} request
   * @param {Response} response
   * @returns {Promise<Response>}
   */
  async function createRangeResponse(request, response) {
    if (!request?.headers || typeof request.headers.get !== 'function') {
      return response;
    }

    const rangeHeader = request.headers.get('range');
    if (!rangeHeader || !response || response.status !== 200) {
      return response;
    }

    const match = rangeHeader.trim().match(/^bytes=\s*(\d*)\s*-\s*(\d*)$/i);
    if (!match) {
      return response;
    }

    let arrayBuffer;
    try {
      arrayBuffer = await response.clone().arrayBuffer();
    } catch {
      return response;
    }

    const totalLength = arrayBuffer.byteLength;
    const startStr = match[1];
    const endStr = match[2];

    let start;
    let end;

    if (!startStr && !endStr) {
      return response;
    }

    if (!startStr) {
      // Suffix range: bytes=-500 (last 500 bytes)
      const suffix = parseInt(endStr, 10);
      if (Number.isNaN(suffix) || suffix <= 0) {
        return new Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: {
            'Content-Range': `bytes */${totalLength}`,
          },
        });
      }
      start = Math.max(0, totalLength - suffix);
      end = totalLength - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr ? parseInt(endStr, 10) : totalLength - 1;
    }

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      start >= totalLength ||
      end < start
    ) {
      return new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: {
          'Content-Range': `bytes */${totalLength}`,
        },
      });
    }

    // Range ends are inclusive
    end = Math.min(end, totalLength - 1);
    const sliced = arrayBuffer.slice(start, end + 1);
    const contentLength = end - start + 1;

    const headers = new Headers(response.headers);
    headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
    headers.set('Content-Length', String(contentLength));
    headers.set('Accept-Ranges', 'bytes');

    return new Response(sliced, {
      status: 206,
      statusText: 'Partial Content',
      headers,
    });
  }

  /**
   * Test whether a URL matches a pattern (glob string, RegExp, or predicate function).
   *
   * @param {string|RegExp|Function} pattern
   * @param {URL} url
   * @returns {boolean}
   */
  function matchesNavigationPattern(pattern, url) {
    if (!pattern) return false;
    if (typeof pattern === 'function') {
      try {
        return Boolean(pattern(url));
      } catch {
        return false;
      }
    }
    if (pattern instanceof RegExp) {
      return pattern.test(url.pathname) || pattern.test(url.href);
    }
    if (typeof pattern === 'string') {
      return matchGlob(pattern, url.pathname) || matchGlob(pattern, url.href);
    }
    return false;
  }

  /**
   * Check whether a navigation request URL is permitted to receive the SPA navigation fallback.
   * Prevents non-SPA paths (such as /api/* or /admin/*) from receiving the index.html shell fallback.
   *
   * @param {string|Request} requestOrUrl
   * @param {Object} [options]
   * @param {Object} [config]
   * @returns {boolean}
   */
  function isNavigationFallbackAllowed(requestOrUrl, options = {}, config = getConfig()) {
    const urlString = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
    let url;
    try {
      url = new URL(urlString, 'http://localhost');
    } catch {
      return false;
    }

    const denylist = options.navigationDenylist ?? config.navigationDenylist ?? [];
    const allowlist = options.navigationAllowlist ?? config.navigationAllowlist ?? [];

    // 1. If URL matches any denylist pattern, fallback is blocked
    if (Array.isArray(denylist)) {
      for (const pattern of denylist) {
        if (matchesNavigationPattern(pattern, url)) {
          return false;
        }
      }
    }

    // 2. If allowlist is specified, URL must match at least one allowlist pattern
    if (Array.isArray(allowlist) && allowlist.length > 0) {
      return allowlist.some((pattern) => matchesNavigationPattern(pattern, url));
    }

    return true;
  }

  /**
   * Collect all active plugins for a given route/options context.
   * Merges global config.plugins with route-level plugins and individual route hook functions.
   *
   * @param {Object} [options]
   * @returns {Array<Object>}
   */
  function getPlugins(options = {}) {
    const globalPlugins = Array.isArray(getConfig()?.plugins) ? getConfig().plugins : [];
    const routePlugins = Array.isArray(options?.plugins) ? options.plugins : [];

    const directHookPlugin = {};
    if (typeof options?.requestWillFetch === 'function') directHookPlugin.requestWillFetch = options.requestWillFetch;
    if (typeof options?.cachedResponseWillBeUsed === 'function') directHookPlugin.cachedResponseWillBeUsed = options.cachedResponseWillBeUsed;
    if (typeof options?.cacheWillUpdate === 'function') directHookPlugin.cacheWillUpdate = options.cacheWillUpdate;
    if (typeof options?.fetchDidSucceed === 'function') directHookPlugin.fetchDidSucceed = options.fetchDidSucceed;
    if (typeof options?.fetchDidFail === 'function') directHookPlugin.fetchDidFail = options.fetchDidFail;
    if (typeof options?.cacheDidUpdate === 'function') directHookPlugin.cacheDidUpdate = options.cacheDidUpdate;

    const plugins = [...globalPlugins, ...routePlugins];
    if (Object.keys(directHookPlugin).length > 0) {
      plugins.push(directHookPlugin);
    }
    return plugins;
  }

  /**
   * Execute requestWillFetch hook chain.
   * Allows plugins to modify the outgoing network Request or inspect headers/URL.
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {Request} params.request
   * @param {FetchEvent} [params.event]
   * @param {Object} [params.options]
   * @returns {Promise<Request>}
   */
  async function runRequestWillFetch(plugins, params) {
    let req = params.request;
    for (const plugin of plugins) {
      if (typeof plugin?.requestWillFetch === 'function') {
        const result = await plugin.requestWillFetch({ ...params, request: req });
        if (result instanceof Request) {
          req = result;
        }
      }
    }
    return req;
  }

  /**
   * Execute cachedResponseWillBeUsed hook chain.
   * Allows plugins to inspect or modify a cached response before it is used.
   * Returning explicit `null` from any plugin marks the cached entry as unusable (cache miss).
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {string} params.cacheName
   * @param {Request} params.request
   * @param {Object} [params.matchOptions]
   * @param {Response} params.cachedResponse
   * @param {FetchEvent} [params.event]
   * @param {Object} [params.options]
   * @returns {Promise<Response|null>}
   */
  async function runCachedResponseWillBeUsed(plugins, params) {
    let cached = params.cachedResponse;
    for (const plugin of plugins) {
      if (typeof plugin?.cachedResponseWillBeUsed === 'function') {
        const result = await plugin.cachedResponseWillBeUsed({ ...params, cachedResponse: cached });
        if (result === null) {
          return null;
        }
        if (result instanceof Response) {
          cached = result;
        }
      }
    }
    return cached;
  }

  /**
   * Execute cacheWillUpdate hook chain.
   * Called before saving a response to CacheStorage.
   * Returning explicit `null` or `false` prevents the response from being cached.
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {Request} params.request
   * @param {Response} params.response
   * @param {FetchEvent} [params.event]
   * @param {string} [params.cacheName]
   * @param {Object} [params.options]
   * @returns {Promise<Response|null>}
   */
  async function runCacheWillUpdate(plugins, params) {
    let resToCache = params.response;
    for (const plugin of plugins) {
      if (typeof plugin?.cacheWillUpdate === 'function') {
        const result = await plugin.cacheWillUpdate({ ...params, response: resToCache });
        if (result === null || result === false) {
          return null;
        }
        if (result instanceof Response) {
          resToCache = result;
        }
      }
    }
    return resToCache;
  }

  /**
   * Execute fetchDidSucceed hook chain.
   * Called after network fetch completes successfully.
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {Request} params.request
   * @param {Response} params.response
   * @param {FetchEvent} [params.event]
   * @param {Object} [params.options]
   * @returns {Promise<Response>}
   */
  async function runFetchDidSucceed(plugins, params) {
    let resp = params.response;
    for (const plugin of plugins) {
      if (typeof plugin?.fetchDidSucceed === 'function') {
        const result = await plugin.fetchDidSucceed({ ...params, response: resp });
        if (result instanceof Response) {
          resp = result;
        }
      }
    }
    return resp;
  }

  /**
   * Execute fetchDidFail hook chain.
   * Called when network fetch fails or throws.
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {Error} params.error
   * @param {Request} params.originalRequest
   * @param {Request} params.request
   * @param {FetchEvent} [params.event]
   * @param {Object} [params.options]
   * @returns {Promise<void>}
   */
  async function runFetchDidFail(plugins, params) {
    for (const plugin of plugins) {
      if (typeof plugin?.fetchDidFail === 'function') {
        try {
          await plugin.fetchDidFail(params);
        } catch (err) {
          logger.warn('[NLPWA] fetchDidFail plugin error:', err?.message || err);
        }
      }
    }
  }

  /**
   * Execute cacheDidUpdate hook chain.
   * Called after a response has been committed to cache.
   *
   * @param {Array<Object>} plugins
   * @param {Object} params
   * @param {string} params.cacheName
   * @param {Request} params.request
   * @param {Response} [params.oldResponse]
   * @param {Response} params.newResponse
   * @param {FetchEvent} [params.event]
   * @param {Object} [params.options]
   * @returns {Promise<void>}
   */
  async function runCacheDidUpdate(plugins, params) {
    for (const plugin of plugins) {
      if (typeof plugin?.cacheDidUpdate === 'function') {
        try {
          await plugin.cacheDidUpdate(params);
        } catch (err) {
          logger.warn('[NLPWA] cacheDidUpdate plugin error:', err?.message || err);
        }
      }
    }
  }

  /**
   * Helper to tag a cached response and handle Range requests if requested.
   *
   * @param {Request} request
   * @param {Response} response
   * @param {string} tag
   * @returns {Promise<Response>}
   */
  async function serveCached(request, response, tag) {
    const tagged = tagResponse(response, tag);
    if (request?.headers && typeof request.headers.has === 'function' && request.headers.has('range')) {
      return createRangeResponse(request, tagged);
    }
    return tagged;
  }

  /**
   * Execute a network fetch through requestWillFetch, fetchDidSucceed, and fetchDidFail plugin hooks.
   *
   * @param {Request} request
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   * @param {Array<Object>} [plugins]
   * @returns {Promise<Response>}
   */
  async function performFetch(request, event, options = {}, plugins = getPlugins(options)) {
    const finalRequest = await runRequestWillFetch(plugins, { request, event, options });
    try {
      const rawResponse = await fetch(finalRequest);
      const finalResponse = await runFetchDidSucceed(plugins, {
        request: finalRequest,
        response: rawResponse,
        event,
        options,
      });
      return finalResponse;
    } catch (err) {
      await runFetchDidFail(plugins, {
        error: err,
        originalRequest: request,
        request: finalRequest,
        event,
        options,
      });
      throw err;
    }
  }

  /**
   * Safely put a response clone into the runtime cache without blocking the main response.
   * - Runs cacheWillUpdate plugin hooks; cancels write if hook returns null/false.
   * - Skips 206 Partial Content (Range requests) to prevent Cache Storage API TypeError.
   * - Skips non-2xx responses.
   * - Catches QuotaExceededError or write failures without breaking the caller.
   * - Runs cacheDidUpdate plugin hook after successful write.
   * - Extends SW lifetime via event.waitUntil() if event is available.
   *
   * @param {Request} request
   * @param {Response} response
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   */
  function safePutInRuntime(request, response, event, options = {}) {
    if (!response || response.status === 206) return Promise.resolve();
    if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) return Promise.resolve();

    // Opaque responses:
    // In Chromium, caching an opaque response (type === 'opaque', status === 0) incurs ~7 MB
    // quota padding to prevent side-channel size attacks, and 404/500 errors cannot be detected.
    // We skip caching opaque responses by default unless explicitly opted in via cacheOpaque: true.
    if (response.type === 'opaque') {
      const allowOpaque = Boolean(
        options?.cacheOpaque ??
        getConfig().cacheOpaque ??
        false
      );
      if (!allowOpaque) {
        return Promise.resolve();
      }
    } else if (!response.ok) {
      return Promise.resolve();
    }

    let toCache;
    try {
      toCache = response.clone();
    } catch (err) {
      logger.warn('[NLPWA] Could not clone response for runtime cache:', err?.message || err);
      return Promise.resolve();
    }

    const asyncWrite = (async () => {
      const plugins = getPlugins(options);
      const cacheName = getConfig().caches?.runtime || 'runtime';

      let responseToCache;
      try {
        responseToCache = await runCacheWillUpdate(plugins, {
          request,
          response: toCache,
          event,
          cacheName,
          options,
        });
      } catch (err) {
        logger.warn('[NLPWA] cacheWillUpdate error:', err?.message || err);
        return;
      }

      if (!responseToCache) return;

      if (responseToCache.type === 'opaque') {
        const allowOpaque = Boolean(
          options?.cacheOpaque ??
          getConfig().cacheOpaque ??
          false
        );
        if (!allowOpaque) return;
      } else if (!responseToCache.ok) {
        return;
      }

      try {
        await putInRuntime(request, responseToCache);
        await runCacheDidUpdate(plugins, {
          cacheName,
          request,
          newResponse: responseToCache,
          event,
          options,
        });
      } catch (err) {
        logger.warn('[NLPWA] Runtime cache write failed:', err?.message || err);
      }
    })();

    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(asyncWrite);
    }
    return asyncWrite;
  }

  /**
   * Determine whether a strategy failure should rethrow/reject instead of returning a 503 response.
   */
  function getShouldThrow(options) {
    return Boolean(
      options?.throwOnFailure ??
      getConfig().throwOnFailure ??
      false
    );
  }

  /**
   * Parse a human-friendly duration string into milliseconds.
   * Supports: '7d', '24h', '30m', '60s', '500ms', or plain numbers (ms).
   *
   * @param {string|number} [val]
   * @returns {number|null}
   */
  function parseDurationMs(val) {
    if (val == null) return null;
    if (typeof val === 'number') {
      return val > 0 ? val : null;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim().toLowerCase();
      const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
      if (!match) return null;
      const num = parseFloat(match[1]);
      const unit = match[2] || 'ms';
      if (unit === 'w') return Math.round(num * 7 * 24 * 60 * 60 * 1000);
      if (unit === 'd') return Math.round(num * 24 * 60 * 60 * 1000);
      if (unit === 'h') return Math.round(num * 60 * 60 * 1000);
      if (unit === 'm') return Math.round(num * 60 * 1000);
      if (unit === 's') return Math.round(num * 1000);
      return Math.round(num);
    }
    return null;
  }

  /**
   * Resolve max age in milliseconds from route options or global config.
   */
  function resolveMaxAgeMs(options) {
    if (options?.maxAge != null) return parseDurationMs(options.maxAge);
    return null;
  }

  /**
   * Resolve offline navigation fallback URL from route options or global config.
   */
  function resolveFallbackUrl(options = {}) {
    return options.offlineFallback ?? options.navigationFallback ?? getConfig().offlineFallback ?? getConfig().navigationFallback ?? '/index.html';
  }

  /**
   * Check if a cached Response has expired based on its cached timestamp and maxAgeMs.
   */
  function isResponseExpired(response, maxAgeMs) {
    if (!maxAgeMs || maxAgeMs <= 0 || !response) return false;
    const cachedAtHeader = response.headers?.get('X-NLPWA-Cached-At');
    let cachedAt = 0;
    if (cachedAtHeader) {
      const parsed = parseInt(cachedAtHeader, 10);
      if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
    } else {
      const dateHeader = response.headers?.get('Date');
      if (dateHeader) {
        const parsed = Date.parse(dateHeader);
        if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
      }
    }
    if (!cachedAt) return false;
    return (Date.now() - cachedAt) > maxAgeMs;
  }

  // ── cache-first ──────────────────────────────────────────────────────────

  /**
   * Serve from offline cache first, then runtime cache.
   * On cache miss, fetch from network and store in runtime cache asynchronously.
   *
   * Best for: static assets, fonts, images — files that rarely change.
   *
   * Response header: X-Cache-Status: offline-cache | runtime-cache | network
   *
   * @param {Request} request
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   * @returns {Promise<Response>}
   */
  async function cacheFirst(request, event, options = {}) {
    const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
    const plugins = getPlugins(options);
    const offlineName = getConfig().caches?.offline || 'offline';
    const runtimeName = getConfig().caches?.runtime || 'runtime';
    const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

    let offlineCached = await getFromOffline(request, matchOptions, clientId);
    if (offlineCached) {
      offlineCached = await runCachedResponseWillBeUsed(plugins, {
        cacheName: offlineName,
        request,
        matchOptions,
        cachedResponse: offlineCached,
        event,
        options,
      });
      if (offlineCached) return serveCached(request, offlineCached, CACHE_STATUS.OFFLINE_CACHE);
    }

    const maxAgeMs = resolveMaxAgeMs(options);
    let runtimeCached = await getFromRuntime(request, matchOptions);
    if (runtimeCached) {
      runtimeCached = await runCachedResponseWillBeUsed(plugins, {
        cacheName: runtimeName,
        request,
        matchOptions,
        cachedResponse: runtimeCached,
        event,
        options,
      });
      if (runtimeCached) {
        const expired = maxAgeMs ? isResponseExpired(runtimeCached, maxAgeMs) : false;
        if (!expired) {
          return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
        }

        // Cached copy has expired: attempt to refresh from network
        try {
          const response = await performFetch(request, event, options, plugins);
          safePutInRuntime(request, response, event, options);
          return tagResponse(response, CACHE_STATUS.NETWORK);
        } catch {
          // Network failed while refreshing expired asset: serve stale cached copy
          return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
        }
      }
    }

    try {
      const response = await performFetch(request, event, options, plugins);
      safePutInRuntime(request, response, event, options);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
        const fallbackUrl = resolveFallbackUrl(options);
        const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
        if (fallbackRes) {
          return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
        }
      }

      if (getShouldThrow(options)) {
        throw err;
      }

      // Return a typed offline error response instead of throwing
      return tagResponse(
        new Response('Offline — no cached version available.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        }),
        CACHE_STATUS.OFFLINE_FALLBACK,
      );
    }
  }

  // ── network-first ──────────────────────────────────────────────────────────

  /**
   * Try network first. On failure or timeout, fall back to cache (offline → runtime).
   * Successful network responses are stored in runtime cache asynchronously.
   * If offline and no cache matches a navigation request, falls back to navigationFallback (e.g. /index.html).
   *
   * Best for: HTML pages, user data — content that should be fresh when online.
   *
   * Response header: X-Cache-Status: network | preload | offline-cache | runtime-cache | offline-fallback
  /** Look in offline then runtime cache; returns a tagged Response or null. */
  async function lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event }) {
    const offlineName = getConfig().caches?.offline || 'offline';
    const runtimeName = getConfig().caches?.runtime || 'runtime';

    let offlineCached = await getFromOffline(request, matchOptions, clientId);
    if (offlineCached) {
      offlineCached = await runCachedResponseWillBeUsed(plugins, {
        cacheName: offlineName,
        request,
        matchOptions,
        cachedResponse: offlineCached,
        event,
        options,
      });
      if (offlineCached) return serveCached(request, offlineCached, CACHE_STATUS.OFFLINE_CACHE);
    }

    let runtimeCached = await getFromRuntime(request, matchOptions);
    if (runtimeCached) {
      runtimeCached = await runCachedResponseWillBeUsed(plugins, {
        cacheName: runtimeName,
        request,
        matchOptions,
        cachedResponse: runtimeCached,
        event,
        options,
      });
      if (runtimeCached) return serveCached(request, runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
    }

    return null;
  }

  /**
   * Fetch from network first. On network failure or timeout, fall back to cache.
   * Write successful responses to the runtime cache asynchronously.
   *
   * Best for: API data, HTML pages that must stay fresh.
   *
   * Response header: X-Cache-Status: network | offline-cache | runtime-cache | offline-fallback
   *
   * @param {Request} request
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   * @returns {Promise<Response>}
   */
  async function networkFirst(request, event, options = {}) {
    const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
    const timeoutMs = options.networkTimeoutMs ?? getConfig().networkTimeoutMs ?? 0;
    const plugins = getPlugins(options);
    const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

    const lookupCache = () => lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event });

    // Navigation preload optimization: parallel fetch started by the browser during SW startup
    let preloadPromise = null;
    if (request.mode === 'navigate' && event?.preloadResponse) {
      preloadPromise = event.preloadResponse;
    }

    let fromPreload = false;
    const networkPromise = (async () => {
      if (preloadPromise) {
        try {
          const preloaded = await preloadPromise;
          if (preloaded) {
            fromPreload = true;
            return runFetchDidSucceed(plugins, {
              request,
              response: preloaded,
              event,
              options,
            });
          }
        } catch {
          // Preload aborted or unavailable; fall through to network fetch
        }
      }
      return performFetch(request, event, options, plugins);
    })();

    try {
      let response;

      if (timeoutMs > 0) {
        const TIMED_OUT = Symbol('timeout');
        let timerId;
        const timeout = new Promise((resolve) => {
          timerId = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });

        let result;
        try {
          result = await Promise.race([networkPromise, timeout]);
        } finally {
          clearTimeout(timerId);
        }

        if (result === TIMED_OUT) {
          // Only give up on the network if we actually have something to serve.
          // With nothing cached, a slow response is better than a synthetic 503,
          // so keep waiting for the original request.
          const cached = await lookupCache();
          if (cached) {
            // Let the slow request finish in the background so the cache is
            // refreshed for next time.
            const refresh = networkPromise
              .then((res) => safePutInRuntime(request, res, event, options))
              .catch(() => {});
            if (event && typeof event.waitUntil === 'function') event.waitUntil(refresh);
            return cached;
          }
          response = await networkPromise;
        } else {
          response = result;
        }
      } else {
        response = await networkPromise;
      }

      safePutInRuntime(request, response, event, options);
      return tagResponse(response, fromPreload ? CACHE_STATUS.PRELOAD : CACHE_STATUS.NETWORK);
    } catch (err) {
      const cached = await lookupCache();
      if (cached) return cached;

      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
        const fallbackUrl = resolveFallbackUrl(options);
        const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
        if (fallbackRes) {
          return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
        }
      }

      if (getShouldThrow(options)) {
        throw err;
      }

      // Return a typed offline error response instead of throwing
      return tagResponse(
        new Response('Offline — network request failed.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        }),
        CACHE_STATUS.OFFLINE_FALLBACK,
      );
    }
  }

  // ── network-only ──────────────────────────────────────────────────────────

  /**
   * Always fetch from network. Never read from or write to any cache.
   *
   * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
   *
   * Response header: X-Cache-Status: network
   *
   * @param {Request} request
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   * @returns {Promise<Response>}
   */
  async function networkOnly(request, event, options = {}) {
    const plugins = getPlugins(options);
    try {
      const response = await performFetch(request, event, options, plugins);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      if (getShouldThrow(options)) {
        throw err;
      }
      return tagResponse(
        new Response('Offline — network request failed.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        }),
        CACHE_STATUS.OFFLINE_FALLBACK,
      );
    }
  }

  // ── stale-while-revalidate ───────────────────────────────────────────────────

  /**
   * Serve from cache immediately (stale), then update the cache in the background.
   * If there is no cached response, fall through to a network fetch (blocks).
   *
   * Best for: feeds, listings, content where slightly stale is acceptable.
   *
   * Response header: X-Cache-Status: stale | network
   *
   * @param {Request} request
   * @param {FetchEvent} [event]  needed to extend SW lifetime for background revalidation
   * @param {Object} [options]
   * @returns {Promise<Response>}
   */
  async function staleWhileRevalidate(request, event, options = {}) {
    const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
    const plugins = getPlugins(options);
    const runtimeName = getConfig().caches?.runtime || 'runtime';
    const offlineName = getConfig().caches?.offline || 'offline';
    const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

    let cached = await getFromRuntime(request, matchOptions);
    let cacheNameUsed = runtimeName;
    if (!cached) {
      cached = await getFromOffline(request, matchOptions, clientId);
      cacheNameUsed = offlineName;
    }

    if (cached) {
      cached = await runCachedResponseWillBeUsed(plugins, {
        cacheName: cacheNameUsed,
        request,
        matchOptions,
        cachedResponse: cached,
        event,
        options,
      });
    }

    const maxAgeMs = resolveMaxAgeMs(options);

    if (cached) {
      const expired = maxAgeMs ? isResponseExpired(cached, maxAgeMs) : false;
      if (!expired) {
        // Serve stale immediately; keep the SW alive for the background refresh.
        const revalidate = (async () => {
          try {
            const response = await performFetch(request, event, options, plugins);
            await safePutInRuntime(request, response, event, options);
            return response;
          } catch {
            // offline during revalidation is fine
          }
        })();
        if (event && typeof event.waitUntil === 'function') event.waitUntil(revalidate);
        return serveCached(request, cached, CACHE_STATUS.STALE);
      }

      // Cached copy has expired: wait for revalidation (network-first semantics),
      // falling back to the expired cached entry if network fails (offline).
      try {
        const response = await performFetch(request, event, options, plugins);
        await safePutInRuntime(request, response, event, options);
        return tagResponse(response, CACHE_STATUS.NETWORK);
      } catch {
        return serveCached(request, cached, CACHE_STATUS.STALE);
      }
    }

    // No cache — wait for network, fall back to offline handling if network fails
    try {
      const response = await performFetch(request, event, options, plugins);
      await safePutInRuntime(request, response, event, options);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
        const fallbackUrl = resolveFallbackUrl(options);
        const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
        if (fallbackRes) {
          return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
        }
      }

      if (getShouldThrow(options)) {
        throw err;
      }

      // Return a typed offline error response instead of throwing
      return tagResponse(
        new Response('Offline — no cached version available.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        }),
        CACHE_STATUS.OFFLINE_FALLBACK,
      );
    }
  }

  // ── cache-only ──────────────────────────────────────────────────────────

  /**
   * Serve exclusively from cache. Never hit the network.
   * Returns a 503 if the resource is not cached (or throws if throwOnFailure is true).
   *
   * Best for: offline-only fallback resources (placeholder pages, offline.html).
   *
   * Response header: X-Cache-Status: offline-cache | runtime-cache | offline-fallback
   *
   * @param {Request} request
   * @param {FetchEvent} [event]
   * @param {Object} [options]
   * @returns {Promise<Response>}
   */
  async function cacheOnly(request, event, options = {}) {
    const matchOptions = options.ignoreSearch ? { ignoreSearch: true } : undefined;
    const plugins = getPlugins(options);
    const clientId = event?.clientId || (request.mode === 'navigate' ? event?.resultingClientId : null);

    const cached = await lookupTaggedCache({ request, matchOptions, clientId, plugins, options, event });
    if (cached) return cached;

    if (request.mode === 'navigate' && isNavigationFallbackAllowed(request, options)) {
      const fallbackUrl = resolveFallbackUrl(options);
      const fallbackRes = await getFromCache(fallbackUrl, undefined, clientId);
      if (fallbackRes) {
        return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
      }
    }

    if (getShouldThrow(options)) {
      throw new Error('Failed to fetch: not available in offline cache.');
    }

    return tagResponse(
      new Response('Not available offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      CACHE_STATUS.OFFLINE_FALLBACK,
    );
  }

  /** Map strategy name → strategy function */
  const STRATEGY_FN = {
    [STRATEGIES.CACHE_FIRST]:            cacheFirst,
    [STRATEGIES.NETWORK_FIRST]:          networkFirst,
    [STRATEGIES.NETWORK_ONLY]:           networkOnly,
    [STRATEGIES.STALE_WHILE_REVALIDATE]: staleWhileRevalidate,
    [STRATEGIES.CACHE_ONLY]:             cacheOnly,
  };

  /**
   * Check whether a request URL corresponds to a precached app shell or manifest file.
   *
   * @param {URL} requestUrl
   * @param {Object} [config]
   * @returns {boolean}
   */
  function isManifestFile(requestUrl, config = getConfig()) {
    if (!config) return false;

    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    if (!isSameOrigin) return false;

    let pathname = requestUrl.pathname;
    if (config.base && pathname.startsWith(config.base)) {
      pathname = pathname.slice(config.base.length);
      if (!pathname.startsWith('/')) pathname = '/' + pathname;
    }

    // 1. Runtime config file is always an app shell asset
    const configPath = config.configPath || '/config.json';
    if (pathname === configPath) return true;

    // 2. Precache files and glob patterns
    const precache = config.precache || [];
    for (const item of precache) {
      if (typeof item !== 'string') continue;
      if (item === pathname || matchGlob(item, pathname)) {
        return true;
      }
      // Handle root / index.html alias
      if (
        (pathname === '/' && (item === '/index.html' || item === 'index.html')) ||
        (pathname === '/index.html' && item === '/')
      ) {
        return true;
      }
    }

    // 3. Active snapshot files (if hydrated in memory)
    const snapshotFiles = getActiveSnapshotPaths();
    if (snapshotFiles && snapshotFiles.has(pathname)) {
      return true;
    }

    return false;
  }

  /**
   * Match a request URL against configured routes.
   * Handles origin matching, base stripping, full URL match patterns, and globs.
   *
   * @param {URL} requestUrl
   * @param {Array<Object>} routes
   * @param {Object} [config]
   * @returns {Object|null} matched route object or null
   */
  function matchRoute(requestUrl, routes = [], config = {}) {
    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    let appPathname = requestUrl.pathname;
    if (config.base && appPathname.startsWith(config.base)) {
      appPathname = appPathname.slice(config.base.length);
      if (!appPathname.startsWith('/')) appPathname = '/' + appPathname;
    }

    for (const route of routes) {
      let routeOrigin = route.origin;
      let matchPattern = route.match;

      // Support full URL patterns directly in match: "https://cdn.jsdelivr.net/npm/**"
      if (!routeOrigin && (matchPattern.startsWith('http://') || matchPattern.startsWith('https://'))) {
        try {
          routeOrigin = new URL(matchPattern.replace(/\*/g, 'x')).origin;
        } catch {
          // fallback
        }
      }

      // If route specifies an origin (e.g. origin: 'https://cdn.example.com' or '*'),
      // match against that. Otherwise default to same-origin only.
      if (routeOrigin) {
        if (routeOrigin !== '*' && routeOrigin !== requestUrl.origin) {
          continue;
        }
      } else if (!isSameOrigin) {
        // Unspecified origin matches ONLY same-origin requests
        continue;
      }

      const regex = globToRegex(matchPattern);
      if (
        regex.test(requestUrl.href) ||
        regex.test(requestUrl.pathname) ||
        regex.test(appPathname)
      ) {
        return route;
      }
    }

    return null;
  }

  /**
   * Resolve the strategy function for a given Request by matching it against
   * config.routes (top-to-bottom, first match wins).
   * Falls back to config.defaultStrategy if no route matches.
   *
   * Built-in non-overridable rule: Manifest and precached app shell files are
   * ALWAYS served cache-first from the active offline cache to protect update
   * atomicity and prevent online requests from bypassing the staged cache.
   *
   * @param {Request} request
   * @returns {Function}  one of the five strategy functions
   */
  function resolveStrategy(request) {
    const { routes, defaultStrategy } = getConfig();

    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return (req, event) => networkOnly(req, event);
    }

    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    // Dev-only bypass: when dev: true or devBypass: true, route Vite internal requests
    // and HMR updates directly to network instead of caching or intercepting them.
    const config = getConfig();
    if (config.dev || config.devBypass) {
      if (
        requestUrl.pathname.startsWith('/@vite/') ||
        requestUrl.pathname.startsWith('/@fs/') ||
        requestUrl.pathname.includes('/.vite/') ||
        requestUrl.pathname.endsWith('.hot-update.json') ||
        requestUrl.searchParams.has('import')
      ) {
        const handler = (req, event) => networkOnly(req, event);
        handler.strategy = 'network-only';
        return handler;
      }
    }

    // Built-in non-overridable rule: Precached / manifest files are ALWAYS served
    // from the active offline cache (cache-first). This guarantees that online
    // requests never bypass the staged cache or produce mixed old/new files.
    if (isManifestFile(requestUrl, getConfig())) {
      const handler = (req, event) => cacheFirst(req, event);
      handler.strategy = 'cache-first';
      return handler;
    }

    const matchedRoute = matchRoute(requestUrl, routes, config);
    if (matchedRoute) {
      const fn = STRATEGY_FN[matchedRoute.strategy] ?? STRATEGY_FN[defaultStrategy] ?? networkFirst;
      const handler = (req, event) => fn(req, event, matchedRoute);
      handler.strategy = matchedRoute.strategy;
      return handler;
    }

    // Cross-origin requests without an explicit origin route pass through without caching
    if (!isSameOrigin) {
      const handler = (req, event) => networkOnly(req, event);
      handler.strategy = 'network-only';
      return handler;
    }

    const defaultFn = STRATEGY_FN[defaultStrategy] ?? networkFirst;
    const handler = (req, event) => defaultFn(req, event);
    handler.strategy = defaultStrategy;
    return handler;
  }

  /**
   * Determine if a URL should remain in any cache.
   *
   * A URL is "cacheable" if it is a precached/manifest app shell file,
   * or if the first matching route in config.routes uses a caching-capable strategy.
   *
   * @param {string} url  full URL string
   * @returns {boolean}
   */
  function isCacheableUrl(url) {
    const config = getConfig();
    const { routes, defaultStrategy } = config;

    let requestUrl;
    try {
      requestUrl = new URL(url);
    } catch {
      return false;
    }

    // Precached / manifest app shell files are always cacheable
    if (isManifestFile(requestUrl, config)) {
      return true;
    }

    const matchedRoute = matchRoute(requestUrl, routes, config);
    if (matchedRoute) {
      return CACHING_CAPABLE_STRATEGIES.has(matchedRoute.strategy);
    }

    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    // Cross-origin requests without an explicit origin route pass through without caching
    if (!isSameOrigin) {
      return false;
    }

    // No route matched — fall back to defaultStrategy
    return CACHING_CAPABLE_STRATEGIES.has(defaultStrategy);
  }

  /**
   * Evict all entries from an opened Cache whose URLs are no longer cacheable
   * according to the current route config.
   *
   * @param {Cache}  cache
   * @param {string} cacheName  for logging
   * @param {Set<string>} protectedPaths  internal entries that must never be evicted
   *                                      (snapshot and runtime config.json)
   */
  async function evictNonCacheable(cache, cacheName, protectedPaths) {
    const keys = await cache.keys();

    await Promise.all(
      keys.map(async (request) => {
        const { pathname } = new URL(request.url);

        // Never evict internal entries: the snapshot and the runtime config
        if (protectedPaths.has(pathname)) return;

        if (!isCacheableUrl(request.url)) {
          await cache.delete(request);
          logger.log(`[NLPWA] Evicted (route no longer cacheable) [${cacheName}]: ${pathname}`);
        }
      })
    );
  }

  /**
   * Run route-aware eviction on both offline and runtime caches.
   *
   * Called after every successful update to clean up entries whose routes
   * have been removed or changed to network-only in the latest config.
   */
  async function evictByRoute() {
    const { caches: cacheNames, snapshotCachePath, configPath, base } = getConfig();
    const rawConfigPath = configPath || '/config.json';
    const baseConfigPath = resolvePathWithBase(rawConfigPath, base);
    const protectedPaths = new Set(
      [snapshotCachePath, rawConfigPath, baseConfigPath].filter(Boolean)
    );

    const [offlineCache, runtimeCache] = await Promise.all([
      openActive(cacheNames.offline),
      caches.open(cacheNames.runtime),
    ]);

    await Promise.all([
      evictNonCacheable(offlineCache, cacheNames.offline, protectedPaths),
      evictNonCacheable(runtimeCache, cacheNames.runtime, protectedPaths),
    ]);
  }

  /**
   * Notify all connected clients with a postMessage.
   *
   * @param {Object} message
   */
  async function broadcast(message) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(client => client.postMessage(message));
  }

  /**
   * Run a complete two-tier update check cycle:
   *
   *   1. Tier 1: lightweight version check (/api/update/version)
   *   2. Stop early if the live version already matches
   *   3. Tier 2: fetch the full file manifest (/api/update/info)
   *   4. Stage: build the new version in a separate cache (copy unchanged files,
   *      fetch + hash-verify the rest). The running app is not touched.
   *   5. Tell clients UPDATE_READY. The switch happens on the next navigation
   *      (or APPLY_UPDATE), so one page load is never served from two versions.
   *
   * On a first install there is nothing to protect, so the staged cache is
   * switched in right away and no banner is shown.
   *
   * Safe to call concurrently: a shared lock lets only one run proceed.
   *
   * @returns {Promise<{ updated: boolean, version?: string }>}
   */
  async function checkForUpdate(options = {}) {
    return await runUpdateCheck(options);
  }

  let _currentStatus = 'idle';

  function setUpdateStatus(status) {
    _currentStatus = status;
  }

  async function getUpdateStatus() {
    const staged = await getStaged();
    if (staged?.complete) return 'ready';
    return _currentStatus;
  }

  async function runUpdateCheck({ force = false } = {}) {
    _currentStatus = 'checking';
    try {
      return await _doUpdateCheck({ force });
    } finally {
      if (_currentStatus === 'checking') {
        _currentStatus = 'idle';
      }
    }
  }

  async function _doUpdateCheck({ force = false } = {}) {
    const config = getConfig();

    // ── Tier 1: lightweight version check ────────────────────────────────────
    let serverVersion;
    try {
      serverVersion = (await fetchServerVersion()).version;
    } catch (err) {
      logger.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest:', err.message);
    }

    const active = await loadCachedSnapshot();
    const staged = await getStaged();

    // A complete update is already staged and waiting for the next navigation.
    if (staged?.complete && staged.swVersion === config.version
        && (!serverVersion || serverVersion === staged.version)) {
      await broadcast({ type: MESSAGE_TYPES.UPDATE_READY, version: staged.version, staged: true });
      return { updated: true, version: staged.version, staged: true };
    }

    // If a previous retry failed and backoff has not expired yet, skip this periodic check unless forced
    if (!force && staged && !staged.complete && staged.nextRetryAt && Date.now() < staged.nextRetryAt) {
      logger.log(`[NLPWA] Staging retry in backoff until ${new Date(staged.nextRetryAt).toISOString()}`);
      return { updated: false, backingOff: true };
    }

    const isFresh = !active;
    const swVersionChanged = Boolean(active?.swVersion && active.swVersion !== config.version);
    const isCurrent = (version) => !isFresh && !swVersionChanged && version === active.version;

    const discardStaged = async () => {
      if (staged) {
        await withLock(async () => {
          logger.log(`[NLPWA] Server rolled back to v${active.version}; clearing staged update v${staged.version}`);
          await clearStaged();
          if (staged.cache) {
            await caches.delete(staged.cache).catch(() => {});
          }
        });
      }
    };

    if (serverVersion && isCurrent(serverVersion)) {
      await discardStaged();
      _currentStatus = 'idle';
      logger.log(`[NLPWA] App already up to date (v${active.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
      return { updated: false, rolledBack: Boolean(staged) };
    }

    // ── Tier 2: full manifest ────────────────────────────────────────────────
    let serverManifest;
    try {
      serverManifest = await fetchServerInfo();
    } catch (err) {
      logger.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
      return { updated: false };
    }

    if (isCurrent(serverManifest.version)) {
      await discardStaged();
      _currentStatus = 'idle';
      logger.log(`[NLPWA] App already up to date (v${active.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
      return { updated: false, rolledBack: Boolean(staged) };
    }

    logger.log(isFresh
      ? `[NLPWA] Initial installation: staging v${serverManifest.version}`
      : `[NLPWA] Update available: v${active.version} → v${serverManifest.version}`);

    // ── Stage (active version keeps serving) ─────────────────────────────────
    // Narrow lock: acquire only around staging cache writes and commit
    _currentStatus = 'staging';
    return withLock(async () => {
      const result = await stageUpdate(serverManifest, { activeSnapshot: active, forceRefetch: swVersionChanged });

      if (result.status === 'incomplete') {
        _currentStatus = 'idle';
        const errorCode = result.hasHashMismatch
          ? 'HASH_MISMATCH'
          : result.quotaExceeded
            ? 'QUOTA_EXCEEDED'
            : 'DOWNLOAD_FAILED';

        const errorMsg = result.hasHashMismatch
          ? `Hash mismatch verification failed for ${result.failed.join(', ')}`
          : result.quotaExceeded
            ? `Storage quota exceeded while staging ${result.failed.join(', ')}`
            : `Failed to download or verify ${result.failed.join(', ')}`;

        await broadcast({
          type: MESSAGE_TYPES.UPDATE_FAILED,
          errorCode,
          version: serverManifest.version,
          failed: result.failed,
          failedDetails: result.failedDetails,
          error: errorMsg,
          retryCount: result.retryCount,
          nextRetryAt: result.nextRetryAt,
          persistent: Boolean(result.persistent),
          hasHashMismatch: Boolean(result.hasHashMismatch),
          quotaExceeded: Boolean(result.quotaExceeded),
        });

        return { updated: false, errorCode, version: serverManifest.version, failed: result.failed, error: errorMsg, quotaExceeded: Boolean(result.quotaExceeded) };
      }

      if (isFresh) {
        _currentStatus = 'idle';
        await commitStaged();
        return { updated: false, version: serverManifest.version, initial: true };
      }

      _currentStatus = 'ready';
      await broadcast({
        type: MESSAGE_TYPES.UPDATE_READY,
        version: serverManifest.version,
        staged: true,
      });
      return { updated: true, version: serverManifest.version, staged: true };
    }, () => {
      logger.log('[NLPWA] Staging already in progress, skipping.');
      return { updated: false };
    });
  }

  /**
   * Make the staged update the live one. The switch itself is ONE write
   * (setActive), so a crash leaves either the old or the new version, never a mix.
   *
   * Caller must hold the lock (see commitIfReady) unless it is the update check.
   *
   * @returns {Promise<boolean>} true if a staged update was committed
   */
  async function commitStaged(event) {
    const config = getConfig();
    const staged = await getStaged();
    if (!staged?.complete) return false;

    // Crash window guard: if worker crashed after setActive but before clearStaged,
    // the staged cache is already the active cache. Discard stale staged pointer.
    const previousActive = await getActive();
    if (previousActive?.cache === staged.cache) {
      await clearStaged();
      return false;
    }

    setUpdateStatus('applying');

    // A complete cache always contains its snapshot. If not, discard it.
    const cache = await caches.open(staged.cache);
    if (!(await cache.match(getSnapshotPath()))) {
      logger.warn('[NLPWA] Staged cache is missing its snapshot, discarding.');
      await clearStaged();
      await caches.delete(staged.cache);
      setUpdateStatus('idle');
      return false;
    }

    await setActive({
      cache: staged.cache,
      version: staged.version,
      swVersion: staged.swVersion,
      ...(config.retainPreviousVersionCache && previousActive?.cache ? { previousCache: previousActive.cache } : {}),
    });
    await clearStaged();

    // Load the newly committed version's configuration immediately so navigation
    // requests resolve against the new version's routes and settings.
    await loadConfigFromCache();
    const currentConfig = getConfig();

    // If the new version opted out of previous cache retention, update pointer
    if (!currentConfig.retainPreviousVersionCache && previousActive?.cache) {
      await setActive({
        cache: staged.cache,
        version: staged.version,
        swVersion: staged.swVersion,
      });
    }

    // Defer heavy disk cleanup and window messaging to event.waitUntil so the navigation
    // response is never blocked, preserving instant first-paint performance.
    const cleanupPromise = (async () => {
      try {
        const shouldClearRuntime = Boolean(
          staged.clearRuntime ||
          config.clearRuntimeOnUpdate ||
          currentConfig.clearRuntimeOnUpdate
        );

        if (shouldClearRuntime) {
          await caches.delete(currentConfig.caches.runtime);
        } else {
          await evictFromRuntime(staged.evict ?? []);
        }
        await evictByRoute();

        const keep = [staged.cache];
        if (currentConfig.retainPreviousVersionCache && previousActive?.cache) {
          keep.push(previousActive.cache);
        }
        const pinned = getAllPinnedCaches();
        keep.push(...pinned);

        await cleanupCaches({
          base: currentConfig.caches.offline,
          runtime: currentConfig.caches.runtime,
          keep,
        });

        if (previousActive && typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
          self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
            clients.forEach((c) => c.postMessage({ type: MESSAGE_TYPES.UPDATE_APPLIED, version: staged.version }));
          }).catch(() => {});
        }
      } catch (err) {
        logger.warn('[NLPWA] Post-commit cleanup failed:', err?.message || err);
      } finally {
        setUpdateStatus('idle');
      }
    })();

    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(cleanupPromise);
    } else {
      await cleanupPromise;
    }

    logger.log(`[NLPWA] Switched to v${staged.version}`);
    return true;
  }

  /**
   * Commit only if no update is currently being staged. Never waits: a page
   * navigation must not be held up by a download, it just tries again next time.
   *
   * @param {ExtendableEvent} [event]
   */
  async function commitIfReady(event) {
    return withLock(() => commitStaged(event), false);
  }

  /** Delete offline caches left behind by interrupted or superseded updates. */
  async function sweepOrphanCaches() {
    const config = getConfig();
    const [staged, active] = await Promise.all([getStaged(), getActive()]);
    const pinned = getAllPinnedCaches();
    await cleanupCaches({
      base: config.caches.offline,
      runtime: config.caches.runtime,
      keep: [await getActiveName(config.caches.offline), staged?.cache, active?.previousCache, ...pinned],
    });
  }

  /**
   * Install-time caching, called from the SW `install` event.
   *
   * Normal path: take the server manifest and run the same stage → verify →
   * commit pipeline as an update. On a first install nothing is running yet, so
   * the staged cache is switched in immediately. When upgrading from an older
   * SW the app is already running, so the staged cache waits for the next
   * navigation like any other update.
   *
   * Because the snapshot is written during install, the first update check sees
   * an up-to-date app instead of re-downloading everything.
   *
   * Fallback (no manifest, e.g. `nlpwa update` was never run): precache from
   * config.precache without hashes. The first update check then builds the
   * hashed snapshot.
   *
   * @returns {Promise<Object|undefined>}
   */
  async function precacheFiles() {
    let manifest = null;
    try {
      manifest = await fetchServerInfo();
    } catch (err) {
      logger.warn(`[NLPWA] No update manifest at install (${err.message})`);
    }

    const activeSnapshot = await loadCachedSnapshot();

    if (manifest) {
      return withLock(async () => {
        const swChanged = Boolean(activeSnapshot?.swVersion && activeSnapshot.swVersion !== getConfig().version);
        const result = await stageUpdate(manifest, { activeSnapshot, forceRefetch: swChanged });
        if (result.status === 'incomplete' && !activeSnapshot) {
          throw new Error(`[NLPWA] Precache incomplete on first install: ${result.failed.join(', ')} failed`);
        }
        if (result.status === 'ready' && !activeSnapshot) {
          await commitStaged();
        }
        return result;
      });
    }

    if (!activeSnapshot) {
      return withLock(async () => {
        return await precacheWithoutManifest();
      });
    }
  }

  async function precacheWithoutManifest() {
    const config = getConfig();
    const rawConfigPath = config.configPath || '/config.json';
    const configPath = resolvePathWithBase(rawConfigPath, config.base);
    
    const offlineCache = await openActive(config.caches.offline);

    try {
      const configRes = await fetch(configPath, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (configRes.ok) {
        const cloned1 = configRes.clone();
        const cloned2 = configPath !== rawConfigPath ? configRes.clone() : null;
        const data = await configRes.json();
        await offlineCache.put(configPath, cloned1);
        if (cloned2) {
          await offlineCache.put(rawConfigPath, cloned2);
        }
        updateActiveConfig(data);
      } else {
        logger.warn(`[NLPWA] Could not fetch ${configPath} (HTTP ${configRes.status})`);
        await loadConfigFromCache();
      }
    } catch (err) {
      logger.warn(`[NLPWA] Network error fetching ${configPath}:`, err.message);
      await loadConfigFromCache();
    }

    const precache = (getConfig().precache || []).filter((u) => typeof u === 'string' && !u.includes('*') && !u.includes('?'));
    // cache: 'reload' skips the HTTP cache so stale bytes are never stored
    const results = await Promise.allSettled(
      precache.map(async (url) => {
        const resolved = resolvePathWithBase(url, config.base);
        const req = new Request(new URL(resolved, self.location.href), { cache: 'reload' });
        await offlineCache.add(req);
        if (resolved !== url) {
          const match = await offlineCache.match(req);
          if (match) await offlineCache.put(url, match.clone());
        }
      })
    );
    const failed = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
        failed.push(precache[i]);
      }
    });

    if (failed.length > 0) {
      throw new Error(`[NLPWA] Precache failed on first install: ${failed.join(', ')} failed`);
    }

    return { status: 'ready', precached: precache.length };
  }

  /**
   * Handle all `fetch` events from the Service Worker.
   *
   * Filters:
   *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
   *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
   *
   * Ensures runtime config is hydrated from offline cache before matching routes,
   * switches to a staged update on navigation requests, and maintains per-client
   * version pins so open tabs are isolated from subsequent updates in other tabs.
   *
   * @param {FetchEvent} event
   */
  function handleFetch(event) {
    const { request } = event;

    // Only intercept GET requests
    if (request.method !== 'GET') return;

    // Only intercept http(s) requests
    if (!request.url.startsWith('http')) return;

    event.respondWith(
      (async () => {
        await ensureConfigReady();
        await initClientPins();

        // A staged update goes live only when a new page load starts, so one
        // page is never served half from the old version and half from the new.
        if (request.mode === 'navigate') {
          await commitIfReady(event).catch((err) => logger.warn('[NLPWA] Commit failed:', err.message));
          const activeCacheName = await getActiveName(getConfig().caches.offline);
          if (event.resultingClientId) {
            pinClient(event.resultingClientId, activeCacheName);
          }
        } else if (event.clientId && !getClientPinnedCache(event.clientId)) {
          // Pin existing client to current active version on its first subresource fetch
          // so mid-session commits in other tabs never break its asset versioning
          const activeCacheName = await getActiveName(getConfig().caches.offline);
          pinClient(event.clientId, activeCacheName);
        }

        const strategyFn = resolveStrategy(request);
        return strategyFn(request, event);
      })()
    );
  }

  /**
   * Initialize the NLPWA Service Worker.
   *
   * @param {Object} userConfig
   */
  function initSW(userConfig = {}) {
    const config = initConfig(userConfig);

    // Eagerly try to hydrate routes and config from offline cache on SW startup
    loadConfigFromCache().catch(() => {});

    // ── install ────────────────────────────────────────────────────────────────
    self.addEventListener('install', (event) => {
      logger.log(`[NLPWA] Installing SW v${config.version}`);
      event.waitUntil(
        (async () => {
          try {
            const result = await precacheFiles();
            // Only skip waiting if staging/installation completed successfully
            if (!result || result.status !== 'incomplete') {
              await self.skipWaiting();
            }
          } catch (err) {
            logger.error('[NLPWA] Install error:', err);
            throw err;
          }
        })()
      );
    });

    // ── activate ───────────────────────────────────────────────────────────────
    self.addEventListener('activate', (event) => {
      logger.log(`[NLPWA] Activated SW v${config.version}`);
      // Only await fast, local operations in waitUntil so fetch events are never blocked
      event.waitUntil(
        (async () => {
          await self.clients.claim();
          if (self.registration && 'navigationPreload' in self.registration) {
            try {
              if (config.navigationPreload) {
                await self.registration.navigationPreload.enable();
                if (typeof config.navigationPreload === 'string') {
                  await self.registration.navigationPreload.setHeaderValue(config.navigationPreload);
                }
              } else {
                await self.registration.navigationPreload.disable();
              }
            } catch {
              // navigationPreload not supported or disabled in browser
            }
          }
          await initClientPins();
          if (self.clients && typeof self.clients.matchAll === 'function') {
            try {
              const activeCache = await getActiveName(config.caches.offline);
              const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
              for (const client of allClients) {
                if (!getClientPinnedCache(client.id)) {
                  pinClient(client.id, activeCache);
                }
              }
              await pruneClientPins();
            } catch {}
          }
          await sweepOrphanCaches().catch(() => {});
          await loadConfigFromCache().catch(() => {});
        })()
      );
    });

    // ── fetch ──────────────────────────────────────────────────────────────────
    self.addEventListener('fetch', handleFetch);

    // ── message ────────────────────────────────────────────────────────────────
    // Clients can trigger a manual update check via:
    //   navigator.serviceWorker.controller.postMessage({ type: 'CHECK_UPDATE' })
    self.addEventListener('message', (event) => {
      const port = event.ports?.[0];
      const reply = (replyType, data, error) => {
        const payload = {
          type: replyType,
          requestId: event.data?.requestId,
          data: data ?? null,
          error: error ? (error.message || String(error)) : undefined,
        };
        if (port) {
          port.postMessage(payload);
        } else {
          event.source?.postMessage(payload);
        }
      };

      switch (event.data?.type) {
        case MESSAGE_TYPES.CHECK_UPDATE:
          event.waitUntil((async () => {
            try {
              const result = await checkForUpdate({ force: true });
              reply(MESSAGE_TYPES.CHECK_UPDATE, { result });
            } catch (err) {
              reply(MESSAGE_TYPES.CHECK_UPDATE, null, err);
            }
          })());
          break;

        case MESSAGE_TYPES.APPLY_UPDATE:
          // Client asked to switch to the staged update now, then it will reload.
          event.waitUntil((async () => {
            const applied = await commitIfReady(event).catch(() => false);
            reply(MESSAGE_TYPES.APPLY_UPDATE_RESULT, { applied });
          })());
          break;

        case MESSAGE_TYPES.GET_CACHE_INFO:
          // Client requests storage quota & cache metrics info
          event.waitUntil((async () => {
            try {
              const info = await getStorageQuotaInfo();
              reply(MESSAGE_TYPES.CACHE_INFO, info);
            } catch (err) {
              reply(MESSAGE_TYPES.CACHE_INFO, null, err);
            }
          })());
          break;

        case MESSAGE_TYPES.CLEANUP_RUNTIME:
          // Client requests runtime cache cleanup
          event.waitUntil((async () => {
            try {
              const result = await cleanRuntimeCache(event.data?.options || {});
              reply(MESSAGE_TYPES.RUNTIME_CLEANED, result);
            } catch (err) {
              reply(MESSAGE_TYPES.RUNTIME_CLEANED, null, err);
            }
          })());
          break;

        case MESSAGE_TYPES.PIN_CLIENT:
          event.waitUntil((async () => {
            const clientId = event.source?.id;
            if (clientId) {
              const cacheName = event.data?.cache || (await getActiveName(config.caches.offline));
              pinClient(clientId, cacheName);
              reply(MESSAGE_TYPES.CLIENT_PINNED, { clientId, cache: cacheName });
            }
          })());
          break;

        case MESSAGE_TYPES.GET_VERSION:
          event.waitUntil((async () => {
            try {
              const active = await getActive();
              const staged = await getStaged();
              const clientId = event.source?.id;
              const pinnedCache = clientId ? getClientPinnedCache(clientId) : null;
              let pinnedVersion = null;
              if (pinnedCache) {
                const match = pinnedCache.match(/@([^-]+)/);
                pinnedVersion = match ? match[1] : (active?.version || null);
              }
              reply(MESSAGE_TYPES.VERSION_INFO, {
                activeVersion: active?.version || null,
                stagedVersion: staged?.complete ? staged.version : null,
                swVersion: config.version,
                pinnedCache: pinnedCache || active?.cache || null,
                pinnedVersion: pinnedVersion || active?.version || null,
              });
            } catch (err) {
              reply(MESSAGE_TYPES.VERSION_INFO, null, err);
            }
          })());
          break;

        case MESSAGE_TYPES.GET_STATUS:
          event.waitUntil((async () => {
            try {
              const status = await getUpdateStatus();
              reply(MESSAGE_TYPES.STATUS_INFO, { status });
            } catch (err) {
              reply(MESSAGE_TYPES.STATUS_INFO, null, err);
            }
          })());
          break;
      }
    });

    // ── periodic background sync ───────────────────────────────────────────────
    self.addEventListener('periodicsync', (event) => {
      if (event.tag === 'nlpwa-update-check') {
        event.waitUntil(checkForUpdate());
      }
    });
  }

  /**
   * Standalone Service Worker entry (built to out/sw.js, the file `nlpwa init` copies).
   *
   * It starts the engine with the defaults below. Everything app-specific
   * (routes, precache list, update endpoints) lives in /config.json, which is
   * stored in the offline cache and applied as soon as it is available.
   *
   * `updateAPI` is set here because the very first install runs before
   * /config.json has been cached, so the engine needs to know where the update
   * manifest is. These match the starter config.js. If you serve the update API
   * elsewhere, build your own entry:
   *
   *   import { initSW } from 'nlpwa/sw';
   *   initSW({ version: '1', updateAPI: { version: '/v', info: '/i' } });
   */

  initSW({
    version: '1',
    configPath: '/config.json',
    updateAPI: {
      version: '/api/update/version.json',
      info: '/api/update/info.json',
    },
  });

})();
