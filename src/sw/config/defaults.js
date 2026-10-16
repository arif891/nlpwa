import { CACHE_NAMES, MANIFEST_CACHE_PATH, STRATEGIES } from '../../shared/constants.js';

/**
 * Default configuration values.
 * All fields are overridable by the user via initConfig(userConfig).
 */
export const DEFAULTS = {
  /** Installed app version — compared against server manifest version */
  version: '0.0.0',

  /** Server endpoint that returns the full file tree manifest */
  manifestEndpoint: '/api/manifest/latest',

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
