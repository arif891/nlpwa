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
   * routes, strategies, or precache list.
   *
   * Changing this triggers the browser's byte-level SW update, and
   * tells NLPWA to wipe old caches and do a clean install.
   *
   * Note: The APP version is NOT configured here — it is auto-generated
   * by the build tool and lives in manifest.json.
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
    version: '/api/update/version',
    info: '/api/update/info',
  },

  /**
   * How often (ms) to automatically check for updates.
   * Set to 0 to disable automatic polling (manual only).
   */
  updateCheckInterval: 60 * 60 * 1000, // 1 hour

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
};
