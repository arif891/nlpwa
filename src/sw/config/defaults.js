import { CACHE_NAMES, MANIFEST_CACHE_PATH, STRATEGIES } from '../../shared/constants.js';

/**
 * Default configuration values.
 * All fields are overridable by the user via initConfig(userConfig).
 */
export const DEFAULTS = {
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
   * skip in-memory clone & buffer to avoid memory spikes and crashes on low-end devices.
   * Default: 20 * 1024 * 1024 (20 MB)
   */
  maxVerifyBytes: 20 * 1024 * 1024,

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
   * Enable development mode (bypasses Vite internal and HMR requests to network).
   * Default: false
   */
  dev: false,

  /** Explicitly bypass Vite dev server and HMR requests to network. Default: false */
  devBypass: false,

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
};
