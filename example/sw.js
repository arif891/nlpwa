/* NLPWA Service Worker — https://github.com/arif891/nlpwa */
(function () {
  'use strict';

  /** Default cache storage names */
  const CACHE_NAMES = {
    OFFLINE: 'offline',
    RUNTIME: 'runtime',
  };

  /** Path inside the offline cache where the snapshot is stored */
  const SNAPSHOT_CACHE_PATH = '/_nlpwa/snapshot.json';
  const MANIFEST_CACHE_PATH = SNAPSHOT_CACHE_PATH;

  /** postMessage type identifiers (SW ↔ client) */
  const MESSAGE_TYPES = {
    UPDATE_READY:    'UPDATE_READY',    // SW → client: new version available
    CHECK_UPDATE:    'CHECK_UPDATE',    // client → SW: trigger manual check
    UPDATE_APPLIED:  'UPDATE_APPLIED',  // SW → client: reply to APPLY_UPDATE ({ applied })
    NO_UPDATE:       'NO_UPDATE',       // SW → client: already up to date
    APPLY_UPDATE:    'APPLY_UPDATE',    // client → SW: switch to the staged update now
    GET_CACHE_INFO:  'GET_CACHE_INFO',  // client → SW: request storage quota & cache metrics
    CACHE_INFO:      'CACHE_INFO',      // SW → client: reply with quota & cache metrics
    CLEANUP_RUNTIME: 'CLEANUP_RUNTIME', // client → SW: request runtime cache cleanup
    RUNTIME_CLEANED: 'RUNTIME_CLEANED', // SW → client: reply with cleanup results
    UPDATE_FAILED:   'UPDATE_FAILED',   // SW → client: update staging or hash verification failed
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

    /** Cache storage names */
    caches: {
      offline: CACHE_NAMES.OFFLINE,
      runtime: CACHE_NAMES.RUNTIME,
    },

    /** Path inside the offline cache where the manifest snapshot is stored */
    manifestCachePath: MANIFEST_CACHE_PATH,

    /**
     * Files to pre-cache at SW install time (the app shell).
     * These are fetched immediately when the SW installs.
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
  };

  const VALID_STRATEGIES = new Set(Object.values(STRATEGIES));

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

  /**
   * Tiny "meta" cache + helpers that make updates atomic.
   *
   *   nlpwa-meta
   *     /_nlpwa/active.json  → { cache, version, swVersion }   which offline cache is live
   *     /_nlpwa/staged.json  → { cache, version, swVersion, complete, retryCount, evict, ... }
   *
   * Each app version lives in its own offline cache (`offline@<version>-<id>`).
   * An update is built in a new cache while the active one keeps serving; the
   * switch is a single write to active.json. With no pointer yet (first run, or
   * an app installed by an older NLPWA) the plain `offline` cache is the active one.
   *
   * This module has no dependency on config so config/index.js can use it.
   */

  const META_CACHE = 'nlpwa-meta';
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
    if (!_activePromise) _activePromise = readMeta(ACTIVE_KEY);
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

  // ── Staged update record ──────────────────────────────────────────────────

  const getStaged = () => readMeta(STAGED_KEY);
  const setStaged = (record) => writeMeta(STAGED_KEY, record);
  const clearStaged = () => deleteMeta(STAGED_KEY);

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

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Delete every offline cache that is neither in `keep` nor the runtime cache.
   * Managed names are the base name itself (legacy) and `<base>@…` (versioned).
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
          console.log(`[NLPWA] Removed old cache: ${name}`);
          return caches.delete(name);
        })
    );
  }

  /** Singleton config instance, set by initConfig() */
  let _config = null;

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
   * Resolves with the active runtime config.
   *
   * @returns {Promise<Object|null>}
   */
  function ensureConfigReady() {
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
  async function loadConfigFromCache() {
    const promise = (async () => {
      const config = _config || initConfig();
      const baseName = config.caches?.offline || 'offline';
      let configPath = config.configPath || '/config.json';
      if (config.base && configPath.startsWith('/')) {
        const cleanBase = config.base.endsWith('/') ? config.base.slice(0, -1) : config.base;
        configPath = `${cleanBase}${configPath}`;
      }

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
    })();

    _configReadyPromise = promise;
    return promise;
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
  function getUpdateEndpoints() {
    const config = getConfig();
    let versionEndpoint = '/api/update/version.json';
    let infoEndpoint = '/api/update/info.json';

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

    const resolveEndpoint = (ep) => {
      if (!ep || /^[a-z][a-z0-9+.-]*:/i.test(ep) || ep.startsWith('//')) return ep;
      if (config.base) {
        const cleanBase = config.base.endsWith('/') ? config.base.slice(0, -1) : config.base;
        if (ep.startsWith('/')) {
          return `${cleanBase}${ep}`;
        }
        return `${cleanBase}/${ep}`;
      }
      return ep;
    };

    return {
      versionEndpoint: resolveEndpoint(versionEndpoint),
      infoEndpoint: resolveEndpoint(infoEndpoint),
    };
  }

  /**
   * Fetch lightweight app version from the server (Tier 1 check).
   *
   * @returns {Promise<{ version: string }>}
   */
  async function fetchServerVersion() {
    const { versionEndpoint } = getUpdateEndpoints();

    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(15000)
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
    const { infoEndpoint } = getUpdateEndpoints();

    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(30000)
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

  const fetchServerManifest = fetchServerInfo;

  /** Path of the snapshot entry inside an offline cache. */
  function getSnapshotPath() {
    const config = getConfig();
    return config.snapshotCachePath || config.manifestCachePath || '/_nlpwa/snapshot.json';
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
    if (!response) return null;
    return response.json();
  }

  const loadCachedManifest = loadCachedSnapshot;

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
    // Reject absolute URLs with protocols (e.g. http:, https:, data:) and protocol-relative URLs (//)
    if (path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
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
   * The CLI emits the first 32 hex characters (older builds emitted 8), so the
   * manifest hash is treated as a prefix. Anything shorter than 8 characters is rejected so a
   * truncated or empty hash can never "match" by accident.
   *
   * @param {string} actualHex  full digest from sha256Hex()
   * @param {string} expected   hash from the manifest (prefix of the digest)
   * @returns {boolean}
   */
  function hashMatches(actualHex, expected) {
    if (typeof expected !== 'string' || expected.length < 8) return false;
    return actualHex.startsWith(expected.toLowerCase());
  }

  /** Run `fn` over `items` with at most `limit` in flight. */
  async function mapLimit(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    });
    await Promise.all(workers);
  }

  /** Is `path` already in the staging cache with the expected content? */
  async function isAlreadyStaged(cache, path, expected, verify) {
    const hit = await cache.match(path);
    if (!hit) return false;
    if (!expected || verify === false) return true;
    return hashMatches(await sha256Hex(await hit.arrayBuffer()), expected);
  }

  /** Fetch a file fresh from the network and check it against its manifest hash. */
  async function fetchVerified(path, expected, verify) {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(30000)
      : undefined;
    const response = await fetch(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    if (expected && verify !== false) {
      const actual = await sha256Hex(await response.clone().arrayBuffer());
      if (!hashMatches(actual, expected)) {
        const detail = `hash mismatch (expected ${expected}, got ${actual.slice(0, expected.length)})`;
        if (verify === 'strict') throw new Error(detail);
        console.warn(`[NLPWA] ${path}: ${detail} - storing anyway (verifyHashes: 'warn')`);
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
   *   { status: 'ready', partial: boolean, failed: string[], reused: number, copied: number, fetched: number } |
   *   { status: 'incomplete', failed: string[], retryCount: number }
   * >}
   */
  async function stageUpdate(manifest, { activeSnapshot = null, forceRefetch = false } = {}) {
    const config = getConfig();
    const verify = config.verifyHashes ?? 'strict';
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
    const activeDegraded = new Set(activeSnapshot?.degraded ?? []);

    const stats = { reused: 0, copied: 0, fetched: 0 };
    const failed = [];
    const failedDetails = {};

    await mapLimit(files, FETCH_CONCURRENCY, async ({ path, hash }) => {
      try {
        if (await isAlreadyStaged(next, path, hash, verify)) {
          stats.reused++;
          return;
        }
        if (!forceRefetch && !activeDegraded.has(path) && activeCache && hash && activeHashes.get(path) === hash) {
          const hit = await activeCache.match(path);
          if (hit) {
            await next.put(path, hit);
            stats.copied++;
            return;
          }
        }
        await next.put(path, await fetchVerified(path, hash, verify));
        stats.fetched++;
      } catch (err) {
        failed.push(path);
        failedDetails[path] = err.message;
        console.warn(`[NLPWA] Staging failed: ${path} - ${err.message}`);
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

      let nextRetryAt = null;
      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        const backoffMs = Math.min(60000 * Math.pow(2, Math.min(retryCount - MAX_RETRY_ATTEMPTS, 6)), 3600000);
        nextRetryAt = Date.now() + backoffMs;
        console.warn(
          `[NLPWA] Staging incomplete: ${failed.length} file(s) failed after ${retryCount} attempts: ` +
          `${failed.join(', ')}. Active version remains live.`
        );
      }

      if (isSameFiles && retryCount >= 2) {
        if (hasHashMismatch) {
          console.error(
            `[NLPWA] Persistent hash mismatch on ${failed.join(', ')} across ${retryCount} attempts. ` +
            `A CDN, proxy, or host minification may be altering file contents in transit. ` +
            `Consider setting verifyHashes: 'warn' or false in your nlpwa config if this transformation is expected.`
          );
        } else {
          console.warn(
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
      partial: false,
      evict,
      clearRuntime: forceRefetch,
    });

    console.log(
      `[NLPWA] Staged v${manifest.version}: ${stats.fetched} fetched, ${stats.copied} copied, ` +
      `${stats.reused} reused`
    );

    return { status: 'ready', partial: false, failed: [], ...stats };
  }

  // ── Offline cache helpers ────────────────────────────────────────────────────

  /**
   * Read a response from the offline (app shell) cache.
   *
   * @param {Request|string} request
   * @returns {Promise<Response|undefined>}
   */
  async function getFromOffline(request, matchOptions) {
    const { caches: cacheNames, retainPreviousVersionCache } = getConfig();
    const cache = await openActive(cacheNames.offline);
    let hit = await cache.match(request, matchOptions);
    if (!hit && retainPreviousVersionCache) {
      const active = await getActive();
      if (active?.previousCache) {
        try {
          const prev = await caches.open(active.previousCache);
          hit = await prev.match(request, matchOptions);
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
   * @returns {Promise<Response|undefined>}
   */
  async function getFromRuntime(request, matchOptions) {
    const { caches: cacheNames } = getConfig();
    const cache = await caches.open(cacheNames.runtime);
    return cache.match(request, matchOptions);
  }

  /**
   * Write a response into the runtime cache.
   * Used by fetch strategies (network-first, stale-while-revalidate, cache-first).
   *
   * @param {Request|string} request
   * @param {Response} response
   */
  async function putInRuntime(request, response) {
    const { caches: cacheNames } = getConfig();
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
          } else {
            try {
              const buf = await response.clone().arrayBuffer();
              headers.set('X-NLPWA-Content-Length', String(buf.byteLength));
              responseToStore = new Response(buf, {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
              await cache.put(request, responseToStore);
              return;
            } catch {
              // fallback
            }
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
  }

  /**
   * Delete specific URLs from the runtime cache.
   * Used during update to evict stale/changed files so they are re-fetched fresh.
   *
   * @param {string[]} paths  URL pathnames to evict, e.g. ['/app.js', '/pages/about.html']
   */
  async function evictFromRuntime(paths) {
    if (!paths.length) return;
    const { caches: cacheNames } = getConfig();
    const cache = await caches.open(cacheNames.runtime);
    await Promise.all(paths.map(path => cache.delete(path)));
  }

  /**
   * Convenience: look up a request from offline first, then runtime.
   * Returns the first match found, or undefined if neither has it.
   *
   * @param {Request|string} request
   * @returns {Promise<Response|undefined>}
   */
  async function getFromCache(request, matchOptions) {
    return (await getFromOffline(request, matchOptions)) ?? (await getFromRuntime(request, matchOptions));
  }

  /** Compiled regex cache — avoids recompiling the same glob on every fetch event */
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
   * Determine if a URL should remain in any cache.
   *
   * A URL is "cacheable" if the first matching route in config.routes uses
   * a caching-capable strategy (cache-first, network-first, stale-while-revalidate,
   * or cache-only). network-only routes are not cacheable.
   *
   * If no route matches, the defaultStrategy is used as the fallback.
   *
   * @param {string} url  full URL string
   * @returns {boolean}
   */
  function isCacheableUrl(url) {
    const { routes, defaultStrategy } = getConfig();

    let requestUrl;
    try {
      requestUrl = new URL(url);
    } catch {
      return false;
    }

    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    for (const route of routes) {
      let routeOrigin = route.origin;
      let matchPattern = route.match;

      if (!routeOrigin && (matchPattern.startsWith('http://') || matchPattern.startsWith('https://'))) {
        try {
          routeOrigin = new URL(matchPattern.replace(/\*/g, 'x')).origin;
        } catch {
          // fallback
        }
      }

      if (routeOrigin) {
        if (routeOrigin !== '*' && routeOrigin !== requestUrl.origin) {
          continue;
        }
      } else if (!isSameOrigin) {
        // Unspecified origin matches ONLY same-origin requests
        continue;
      }

      if (matchGlob(matchPattern, requestUrl.href) || matchGlob(matchPattern, requestUrl.pathname)) {
        return CACHING_CAPABLE_STRATEGIES.has(route.strategy);
      }
    }

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
          console.log(`[NLPWA] Evicted (route no longer cacheable) [${cacheName}]: ${pathname}`);
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
    const { caches: cacheNames, manifestCachePath, snapshotCachePath, configPath } = getConfig();
    const protectedPaths = new Set(
      [manifestCachePath, snapshotCachePath, configPath || '/config.json'].filter(Boolean)
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
   * Make the staged update the live one. The switch itself is ONE write
   * (setActive), so a crash leaves either the old or the new version, never a mix.
   *
   * Caller must hold the lock (see commitIfReady) unless it is the update check.
   *
   * @returns {Promise<boolean>} true if a staged update was committed
   */
  async function commitStaged() {
    const config = getConfig();
    const staged = await getStaged();
    if (!staged?.complete) return false;

    // A complete cache always contains its snapshot. If not, discard it.
    const cache = await caches.open(staged.cache);
    if (!(await cache.match(getSnapshotPath()))) {
      console.warn('[NLPWA] Staged cache is missing its snapshot, discarding.');
      await clearStaged();
      await caches.delete(staged.cache);
      return false;
    }

    const previousActive = await getActive();
    await setActive({
      cache: staged.cache,
      version: staged.version,
      swVersion: staged.swVersion,
      ...(config.retainPreviousVersionCache && previousActive?.cache ? { previousCache: previousActive.cache } : {}),
    });
    await clearStaged();

    // Everything below is cleanup after the switch; the new version is already live.
    await loadConfigFromCache();
    const currentConfig = getConfig();
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
    if (config.retainPreviousVersionCache && previousActive?.cache) {
      keep.push(previousActive.cache);
    }
    await cleanupCaches({ base: config.caches.offline, runtime: config.caches.runtime, keep });

    if (previousActive && typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'UPDATE_APPLIED', version: staged.version }));
      }).catch(() => {});
    }

    console.log(`[NLPWA] Switched to v${staged.version}`);
    return true;
  }

  /**
   * Commit only if no update is currently being staged. Never waits: a page
   * navigation must not be held up by a download, it just tries again next time.
   */
  async function commitIfReady() {
    if (!tryAcquire()) return false;
    try {
      return await commitStaged();
    } finally {
      release();
    }
  }

  /** Delete offline caches left behind by interrupted or superseded updates. */
  async function sweepOrphanCaches() {
    const config = getConfig();
    const staged = await getStaged();
    await cleanupCaches({
      base: config.caches.offline,
      runtime: config.caches.runtime,
      keep: [await getActiveName(config.caches.offline), staged?.cache],
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
   */
  async function precacheFiles() {
    if (!tryAcquire()) return;
    try {
      let manifest = null;
      try {
        manifest = await fetchServerManifest();
      } catch (err) {
        console.warn(`[NLPWA] No update manifest at install (${err.message})`);
      }

      const activeSnapshot = await loadCachedSnapshot();

      if (manifest) {
        const swChanged = Boolean(activeSnapshot?.swVersion && activeSnapshot.swVersion !== getConfig().version);
        const result = await stageUpdate(manifest, { activeSnapshot, forceRefetch: swChanged });
        if (result.status === 'incomplete' && !activeSnapshot) {
          throw new Error(`[NLPWA] Precache incomplete on first install: ${result.failed.join(', ')} failed`);
        }
        if (result.status === 'ready' && !activeSnapshot) {
          await commitStaged();
        }
        return result;
      }

      if (!activeSnapshot) {
        return await precacheWithoutManifest();
      }
    } finally {
      release();
    }
  }

  async function precacheWithoutManifest() {
    const config = getConfig();
    const configPath = config.configPath || '/config.json';
    
    const offlineCache = await openActive(config.caches.offline);

    try {
      const configRes = await fetch(configPath, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (configRes.ok) {
        const cloned = configRes.clone();
        const data = await configRes.json();
        await offlineCache.put(configPath, cloned);
        updateActiveConfig(data);
      } else {
        console.warn(`[NLPWA] Could not fetch ${configPath} (HTTP ${configRes.status})`);
        await loadConfigFromCache();
      }
    } catch (err) {
      console.warn(`[NLPWA] Network error fetching ${configPath}:`, err.message);
      await loadConfigFromCache();
    }

    const precache = (getConfig().precache || []).filter((u) => typeof u === 'string' && !u.includes('*') && !u.includes('?'));
    // cache: 'reload' skips the HTTP cache so stale bytes are never stored
    const results = await Promise.allSettled(
      precache.map((url) => offlineCache.add(new Request(new URL(url, self.location.href), { cache: 'reload' })))
    );
    const failed = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
        failed.push(precache[i]);
      }
    });

    if (failed.length > 0) {
      throw new Error(`[NLPWA] Precache failed on first install: ${failed.join(', ')} failed`);
    }

    return { status: 'ready', precached: precache.length };
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

    for (const req of requests) {
      const res = await cache.match(req);
      if (res) {
        const meta = await getResponseMetadata(res);
        runtimeBytes += meta.size;
        entries.push({
          url: typeof req === 'string' ? req : req.url,
          size: meta.size,
          cachedAt: meta.cachedAt,
        });
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
  async function cleanRuntimeCache(options = {}) {
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

    for (const req of requests) {
      const res = await cache.match(req);
      if (res) {
        const meta = await getResponseMetadata(res);
        totalBytes += meta.size;
        allItems.push({
          req,
          url: typeof req === 'string' ? req : req.url,
          size: meta.size,
          cachedAt: meta.cachedAt,
        });
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

    await Promise.all(
      evicted.map(async (item) => {
        freedBytes += item.size;
        await cache.delete(item.req);
      })
    );

    const finalRemainingEntries = allItems.length - evicted.length;
    const finalRemainingBytes = Math.max(0, totalBytes - freedBytes);
    const updatedQuota = await getStorageQuotaInfo();

    console.log(
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
   * Safely put a response clone into the runtime cache without blocking the main response.
   * - Skips 206 Partial Content (Range requests) to prevent Cache Storage API TypeError.
   * - Skips non-2xx responses.
   * - Catches QuotaExceededError or write failures without breaking the caller.
   * - Extends SW lifetime via event.waitUntil() if event is available.
   *
   * @param {Request} request
   * @param {Response} response
   * @param {FetchEvent} [event]
   */
  function safePutInRuntime(request, response, event) {
    if (!response || (!response.ok && response.type !== 'opaque') || response.status === 206) return Promise.resolve();
    if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) return Promise.resolve();

    try {
      const clone = response.clone();
      const writePromise = putInRuntime(request, clone).catch((err) => {
        console.warn('[NLPWA] Runtime cache write failed:', err.message);
      });

      if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(writePromise);
      }
      return writePromise;
    } catch (err) {
      console.warn('[NLPWA] Could not clone response for runtime cache:', err.message);
      return Promise.resolve();
    }
  }

  /**
   * Determine whether a strategy failure should rethrow/reject instead of returning a 503 response.
   */
  function getShouldThrow(options) {
    return Boolean(
      options?.throwOnFailure ??
      options?.throwOfflineError ??
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
    if (options?.maxAgeMs != null) return parseDurationMs(options.maxAgeMs);
    if (options?.maxAgeSeconds != null) return options.maxAgeSeconds * 1000;
    if (options?.maxAge != null) return parseDurationMs(options.maxAge);
    if (options?.ttl != null) return parseDurationMs(options.ttl);
    return null;
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
        const parsed = new Date(dateHeader).getTime();
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

    const offlineCached = await getFromOffline(request, matchOptions);
    if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

    const maxAgeMs = resolveMaxAgeMs(options);
    const runtimeCached = await getFromRuntime(request, matchOptions);
    if (runtimeCached) {
      const expired = maxAgeMs ? isResponseExpired(runtimeCached, maxAgeMs) : false;
      if (!expired) {
        return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
      }

      // Cached copy has expired: attempt to refresh from network
      try {
        const response = await fetch(request);
        safePutInRuntime(request, response, event);
        return tagResponse(response, CACHE_STATUS.NETWORK);
      } catch {
        // Network failed while refreshing expired asset: serve stale cached copy
        return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);
      }
    }

    try {
      const response = await fetch(request);
      safePutInRuntime(request, response, event);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate') {
        const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
        const fallbackRes = await getFromCache(fallbackUrl);
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

    /** Look in offline then runtime cache; returns a tagged Response or null. */
    const lookupCache = async () => {
      const offlineCached = await getFromOffline(request, matchOptions);
      if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

      const runtimeCached = await getFromRuntime(request, matchOptions);
      if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

      return null;
    };

    const networkPromise = fetch(request);

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
              .then((res) => safePutInRuntime(request, res, event))
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

      safePutInRuntime(request, response, event);
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      const cached = await lookupCache();
      if (cached) return cached;

      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate') {
        const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
        const fallbackRes = await getFromCache(fallbackUrl);
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
    try {
      return tagResponse(await fetch(request), CACHE_STATUS.NETWORK);
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
    const cached = (await getFromRuntime(request, matchOptions)) ?? (await getFromOffline(request, matchOptions));

    // Single network request, shared by the background refresh and the
    // cache-miss path. Wrap in async IIFE so synchronous exceptions in fetch are caught.
    const revalidate = (async () => {
      const response = await fetch(request);
      await safePutInRuntime(request, response, event);
      return response;
    })();

    if (cached) {
      // Serve stale immediately; keep the SW alive for the background refresh.
      const settled = revalidate.catch(() => {/* offline during revalidation is fine */});
      if (event && typeof event.waitUntil === 'function') event.waitUntil(settled);
      return tagResponse(cached, CACHE_STATUS.STALE);
    }

    // No cache — wait for network, fall back to offline handling if network fails
    try {
      const response = await revalidate;
      return tagResponse(response, CACHE_STATUS.NETWORK);
    } catch (err) {
      // Navigation fallback for SPAs or offline pages
      if (request.mode === 'navigate') {
        const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
        const fallbackRes = await getFromCache(fallbackUrl);
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

    const offlineCached = await getFromOffline(request, matchOptions);
    if (offlineCached) return tagResponse(offlineCached, CACHE_STATUS.OFFLINE_CACHE);

    const runtimeCached = await getFromRuntime(request, matchOptions);
    if (runtimeCached) return tagResponse(runtimeCached, CACHE_STATUS.RUNTIME_CACHE);

    if (request.mode === 'navigate') {
      const fallbackUrl = options.navigationFallback ?? getConfig().navigationFallback ?? '/index.html';
      const fallbackRes = await getFromCache(fallbackUrl);
      if (fallbackRes) {
        return tagResponse(fallbackRes, CACHE_STATUS.OFFLINE_CACHE);
      }
    }

    if (getShouldThrow(options)) {
      throw new TypeError('Failed to fetch: not available in offline cache.');
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
   * Resolve the strategy function for a given Request by matching it against
   * config.routes (top-to-bottom, first match wins).
   * Falls back to config.defaultStrategy if no route matches.
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
      return (req, event) => networkOnly(req);
    }

    const isSameOrigin = typeof self !== 'undefined' && self.location
      ? requestUrl.origin === self.location.origin
      : true;

    // Always bypass Vite internal dev requests and HMR updates directly to network
    if (
      requestUrl.pathname.startsWith('/@vite/') ||
      requestUrl.pathname.startsWith('/@fs/') ||
      requestUrl.pathname.includes('/.vite/') ||
      requestUrl.pathname.endsWith('.hot-update.json') ||
      requestUrl.searchParams.has('import')
    ) {
      return (req, event) => networkOnly(req);
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

      if (matchGlob(matchPattern, requestUrl.href) || matchGlob(matchPattern, requestUrl.pathname)) {
        const fn = STRATEGY_FN[route.strategy] ?? STRATEGY_FN[defaultStrategy] ?? networkFirst;
        return (req, event) => fn(req, event, route);
      }
    }

    // Cross-origin requests without an explicit origin route pass through without caching
    if (!isSameOrigin) {
      return (req, event) => networkOnly(req);
    }

    const defaultFn = STRATEGY_FN[defaultStrategy] ?? networkFirst;
    return (req, event) => defaultFn(req, event);
  }

  /**
   * Handle all `fetch` events from the Service Worker.
   *
   * Filters:
   *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
   *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
   *
   * Ensures runtime config is hydrated from offline cache before matching routes,
   * and switches to a staged update on navigation requests.
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
        // A staged update goes live only when a new page load starts, so one
        // page is never served half from the old version and half from the new.
        if (request.mode === 'navigate') {
          await commitIfReady().catch((err) => console.warn('[NLPWA] Commit failed:', err.message));
        }
        const strategyFn = resolveStrategy(request);
        return strategyFn(request, event);
      })()
    );
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
    if (!tryAcquire()) {
      console.log('[NLPWA] Update already in progress, skipping.');
      return { updated: false };
    }
    try {
      return await runUpdateCheck(options);
    } finally {
      release();
    }
  }

  async function runUpdateCheck({ force = false } = {}) {
    const config = getConfig();

    // ── Tier 1: lightweight version check ────────────────────────────────────
    let serverVersion;
    try {
      serverVersion = (await fetchServerVersion()).version;
    } catch (err) {
      console.warn('[NLPWA] Cannot reach version endpoint, falling back to manifest:', err.message);
    }

    const active = await loadCachedManifest();
    const staged = await getStaged();

    // A complete update is already staged and waiting for the next navigation.
    if (staged?.complete && staged.swVersion === config.version
        && (!serverVersion || serverVersion === staged.version)) {
      await broadcast({ type: MESSAGE_TYPES.UPDATE_READY, version: staged.version, partial: Boolean(staged.partial), staged: true });
      return { updated: true, version: staged.version, staged: true };
    }

    // If a previous retry failed and backoff has not expired yet, skip this periodic check unless forced
    if (!force && staged && !staged.complete && staged.nextRetryAt && Date.now() < staged.nextRetryAt) {
      console.log(`[NLPWA] Staging retry in backoff until ${new Date(staged.nextRetryAt).toISOString()}`);
      return { updated: false, backingOff: true };
    }

    const isFresh = !active;
    const swVersionChanged = Boolean(active?.swVersion && active.swVersion !== config.version);
    const needsRetry = Boolean(active?.needsRetry || (active?.degraded && active.degraded.length > 0));
    const isCurrent = (version) => !isFresh && !swVersionChanged && !needsRetry && version === active.version;

    if (serverVersion && isCurrent(serverVersion)) {
      console.log(`[NLPWA] App already up to date (v${active.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
      return { updated: false };
    }

    // ── Tier 2: full manifest ────────────────────────────────────────────────
    let serverManifest;
    try {
      serverManifest = await fetchServerManifest();
    } catch (err) {
      console.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
      return { updated: false };
    }

    if (isCurrent(serverManifest.version)) {
      console.log(`[NLPWA] App already up to date (v${active.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: active.version });
      return { updated: false };
    }

    console.log(isFresh
      ? `[NLPWA] Initial installation: staging v${serverManifest.version}`
      : `[NLPWA] Update available: v${active.version} → v${serverManifest.version}`);

    // ── Stage (active version keeps serving) ─────────────────────────────────
    const result = await stageUpdate(serverManifest, { activeSnapshot: active, forceRefetch: swVersionChanged });

    if (result.status === 'incomplete') {
      const errorMsg = result.hasHashMismatch
        ? `Hash mismatch verification failed for ${result.failed.join(', ')}`
        : `Failed to download or verify ${result.failed.join(', ')}`;

      await broadcast({
        type: MESSAGE_TYPES.UPDATE_FAILED,
        version: serverManifest.version,
        failed: result.failed,
        failedDetails: result.failedDetails,
        error: errorMsg,
        retryCount: result.retryCount,
        nextRetryAt: result.nextRetryAt,
        persistent: Boolean(result.persistent),
        hasHashMismatch: Boolean(result.hasHashMismatch),
      });

      return { updated: false, version: serverManifest.version, failed: result.failed, error: errorMsg };
    }

    if (isFresh) {
      await commitStaged();
      return { updated: false, version: serverManifest.version, initial: true };
    }

    await broadcast({
      type: MESSAGE_TYPES.UPDATE_READY,
      version: serverManifest.version,
      partial: result.partial,
      staged: true,
    });
    return { updated: true, version: serverManifest.version, staged: true };
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
      console.log(`[NLPWA] Installing SW v${config.version}`);
      event.waitUntil(
        (async () => {
          try {
            const result = await precacheFiles();
            // Only skip waiting if staging/installation completed successfully
            if (!result || result.status !== 'incomplete') {
              await self.skipWaiting();
            }
          } catch (err) {
            console.error('[NLPWA] Install error:', err);
            throw err;
          }
        })()
      );
    });

    // ── activate ───────────────────────────────────────────────────────────────
    self.addEventListener('activate', (event) => {
      console.log(`[NLPWA] Activated SW v${config.version}`);
      event.waitUntil(
        self.clients.claim().then(async () => {
          await sweepOrphanCaches().catch(() => {});
          await loadConfigFromCache();
          return checkForUpdate();
        })
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
          event.waitUntil(checkForUpdate({ force: true }));
          break;

        case MESSAGE_TYPES.APPLY_UPDATE:
          // Client asked to switch to the staged update now, then it will reload.
          event.waitUntil((async () => {
            const applied = await commitIfReady().catch(() => false);
            reply(MESSAGE_TYPES.UPDATE_APPLIED, { applied });
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
