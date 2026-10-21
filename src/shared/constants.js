/** Default cache storage names */
export const CACHE_NAMES = {
  OFFLINE: 'offline',
  RUNTIME: 'runtime',
  META:    'nlpwa-meta',
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
  GET_VERSION:         'GET_VERSION',         // client → SW: request current active and staged version
  VERSION_INFO:        'VERSION_INFO',        // SW → client: reply with version info
  GET_STATUS:          'GET_STATUS',          // client → SW: request update status
  STATUS_INFO:         'STATUS_INFO',         // SW → client: reply with update status
  STAGING_PROGRESS:    'STAGING_PROGRESS',    // SW → client: progress during update staging
  PIN_CLIENT:          'PIN_CLIENT',          // client → SW: attach and pin this client to an active version
  CLIENT_PINNED:       'CLIENT_PINNED',       // SW → client: reply confirming client version pin
  UNPIN_CLIENT:        'UNPIN_CLIENT',        // client → SW: remove client pin
  CLIENT_UNPINNED:     'CLIENT_UNPINNED',     // SW → client: reply confirming client version unpin
  UPDATE_REQUIRED:     'UPDATE_REQUIRED',     // SW → client: active/pinned version is below minimum supported version
  SET_BADGE:           'SET_BADGE',           // client → SW: request badge update
  CLEAR_BADGE:         'CLEAR_BADGE',         // client → SW: request badge clear
  BADGE_RESULT:        'BADGE_RESULT',        // SW → client: reply confirming badge action
  GET_SHARED_DATA:     'GET_SHARED_DATA',     // client → SW: request pending Web Share Target payload
  SHARED_DATA:         'SHARED_DATA',         // SW → client: reply or broadcast with Web Share Target payload
  REPORT_BOOT_HEALTH:  'REPORT_BOOT_HEALTH',  // client → SW: client reports healthy startup
  REPORT_BOOT_FAILURE: 'REPORT_BOOT_FAILURE', // client → SW: client reports startup crash or error
  TRIGGER_ROLLBACK:    'TRIGGER_ROLLBACK',    // client → SW: request immediate rollback to fallback version
  ROLLBACK_APPLIED:    'ROLLBACK_APPLIED',    // SW → client: broadcast confirming rollback executed ({ version, previousVersion, reason })
  GET_BLOCKED_VERSIONS:'GET_BLOCKED_VERSIONS',// client → SW: request blocked/blacklisted versions
  BLOCKED_VERSIONS_INFO:'BLOCKED_VERSIONS_INFO',// SW → client: reply with blocked versions
  UPDATE_DEFERRED:     'UPDATE_DEFERRED',     // SW → client: update check deferred due to saveData, metered connection, or byte budget
  GET_DIAGNOSTICS:     'GET_DIAGNOSTICS',     // client → SW: request comprehensive diagnostics info
  DIAGNOSTICS_INFO:    'DIAGNOSTICS_INFO',    // SW → client: reply with comprehensive diagnostics
  GET_PIN_STATUS:      'GET_PIN_STATUS',      // client → SW: request pin state of client
  PIN_STATUS_INFO:     'PIN_STATUS_INFO',     // SW → client: reply with pin state info
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

/** Default network timeout for single-file staging fetch (30 seconds) */
export const DEFAULT_STAGING_FETCH_TIMEOUT_MS = 30000;

/** Default interval between staging progress broadcasts (250 ms) */
export const DEFAULT_PROGRESS_THROTTLE_MS = 250;

/** Maximum exponential backoff cap between repeated failed update checks (1 hour) */
export const MAX_BACKOFF_MS = 3600000;
