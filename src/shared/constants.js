/** Default cache storage names */
export const CACHE_NAMES = {
  OFFLINE: 'offline',
  RUNTIME: 'runtime',
};

/** Path inside the offline cache where the snapshot is stored */
export const SNAPSHOT_CACHE_PATH = '/_nlpwa/snapshot.json';

/** postMessage type identifiers (SW ↔ client) */
export const MESSAGE_TYPES = {
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
};

/** Runtime cache cleanup strategies */
export const CLEANUP_STRATEGIES = {
  LARGEST: 'largest', // Evict largest files first (or files above size threshold)
  LRU:     'lru',     // Evict oldest / least-recently-cached first
  MAX_AGE: 'max-age', // Evict files older than maxAgeMs
  QUOTA:   'quota',   // Evict when quota usage exceeds threshold
  PATTERN: 'pattern', // Evict files matching glob pattern
  ALL:     'all',     // Wipe all runtime cache entries
};

/** Max parallel downloads while staging an update. */
export const FETCH_CONCURRENCY = 6;

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
