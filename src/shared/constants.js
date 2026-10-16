/** Default cache storage names */
export const CACHE_NAMES = {
  OFFLINE: 'offline',
  RUNTIME: 'runtime',
};

/** Path inside the offline cache where the snapshot is stored */
export const SNAPSHOT_CACHE_PATH = '/_nlpwa/snapshot.json';
export const MANIFEST_CACHE_PATH = SNAPSHOT_CACHE_PATH;

/** postMessage type identifiers (SW ↔ client) */
export const MESSAGE_TYPES = {
  UPDATE_READY:   'UPDATE_READY',   // SW → client: new version available
  CHECK_UPDATE:   'CHECK_UPDATE',   // client → SW: trigger manual check
  UPDATE_APPLIED: 'UPDATE_APPLIED', // SW → client: update successfully applied
  NO_UPDATE:      'NO_UPDATE',      // SW → client: already up to date
};

/** Fetch strategy names */
export const STRATEGIES = {
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
export const CACHING_CAPABLE_STRATEGIES = new Set([
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
export const MAX_RETRY_ATTEMPTS = 5;
