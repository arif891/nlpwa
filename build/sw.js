/* NLPWA Service Worker — https://github.com/your-org/nlpwa */
/** Default cache storage names */
const CACHE_NAMES = {
  OFFLINE: 'offline',
  RUNTIME: 'runtime',
};

/** Path inside the offline cache where the manifest snapshot is stored */
const MANIFEST_CACHE_PATH = '/_nlpwa/manifest.json';

/** postMessage type identifiers (SW ↔ client) */
const MESSAGE_TYPES = {
  UPDATE_READY:   'UPDATE_READY',   // SW → client: new version available
  CHECK_UPDATE:   'CHECK_UPDATE',   // client → SW: trigger manual check
  UPDATE_APPLIED: 'UPDATE_APPLIED', // SW → client: update successfully applied
  NO_UPDATE:      'NO_UPDATE',      // SW → client: already up to date
};

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
 * Default configuration values.
 * All fields are overridable by the user via initConfig(userConfig).
 */
const DEFAULTS = {
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
    errors.push('config.version must be a non-empty string (e.g. "1.0.0")');
  }

  if (typeof config.manifestEndpoint !== 'string' || !config.manifestEndpoint) {
    errors.push('config.manifestEndpoint must be a non-empty string');
  }

  if (typeof config.updateCheckInterval !== 'number' || config.updateCheckInterval < 0) {
    errors.push('config.updateCheckInterval must be a non-negative number (ms)');
  }

  if (!config.caches || typeof config.caches.offline !== 'string') {
    errors.push('config.caches.offline must be a string');
  }

  if (!config.caches || typeof config.caches.runtime !== 'string') {
    errors.push('config.caches.runtime must be a string');
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
 * Pre-cache all files listed in config.precache into the offline cache.
 * Called during the SW `install` event via event.waitUntil().
 *
 * Uses Promise.allSettled so a single failed fetch doesn't abort the install.
 * Failed URLs are logged as warnings and will be retried on the next update check.
 */
async function precacheFiles() {
  const { caches: cacheNames, precache } = getConfig();

  if (!precache.length) return;

  const cache = await caches.open(cacheNames.offline);

  const results = await Promise.allSettled(
    precache.map(url => cache.add(url))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[NLPWA] Precache failed: ${precache[i]}`, result.reason);
    } else {
      console.log(`[NLPWA] Precached: ${precache[i]}`);
    }
  });
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   **   matches anything, including path separators  e.g. /assets/**
 *   *    matches anything except /                    e.g. /pages/*
 *   ?    matches a single character except /
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  const regexStr = pattern
    // Escape all regex special chars except our glob chars (* ?)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Replace ** before * to avoid double-processing
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    // * → match anything except /
    .replace(/\*/g, '[^/]*')
    // ? → match single char except /
    .replace(/\?/g, '[^/]')
    // Restore ** → match anything including /
    .replace(/\x00GLOBSTAR\x00/g, '.*');

  return new RegExp('^' + regexStr + '$');
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
    const { pathname } = new URL(url, 'http://localhost');
    return globToRegex(pattern).test(pathname);
  } catch {
    return false;
  }
}

// ── Offline cache helpers ────────────────────────────────────────────────────

/**
 * Read a response from the offline (app shell) cache.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
async function getFromOffline(request) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.offline);
  return cache.match(request);
}

/**
 * Write a response into the offline cache.
 * Used by the update system to store fresh file fetches.
 *
 * @param {Request|string} request
 * @param {Response} response
 */
async function putInOffline(request, response) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.offline);
  await cache.put(request, response.clone());
}

/**
 * Delete a URL from the offline cache.
 *
 * @param {Request|string} request
 */
async function deleteFromOffline(request) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.offline);
  await cache.delete(request);
}

// ── Runtime cache helpers ────────────────────────────────────────────────────

/**
 * Read a response from the runtime (lazy) cache.
 *
 * @param {Request|string} request
 * @returns {Promise<Response|undefined>}
 */
async function getFromRuntime(request) {
  const { caches: cacheNames } = getConfig();
  const cache = await caches.open(cacheNames.runtime);
  return cache.match(request);
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
  await cache.put(request, response.clone());
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
async function getFromCache(request) {
  return (await getFromOffline(request)) ?? (await getFromRuntime(request));
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

  for (const route of routes) {
    if (matchGlob(route.match, url)) {
      return CACHING_CAPABLE_STRATEGIES.has(route.strategy);
    }
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
 * @param {string} [manifestCachePath]  path to skip (internal manifest entry)
 */
async function evictNonCacheable(cache, cacheName, manifestCachePath) {
  const keys = await cache.keys();

  await Promise.all(
    keys.map(async (request) => {
      const { pathname } = new URL(request.url);

      // Never evict the internal manifest snapshot
      if (pathname === manifestCachePath) return;

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
  const { caches: cacheNames, manifestCachePath } = getConfig();

  const [offlineCache, runtimeCache] = await Promise.all([
    caches.open(cacheNames.offline),
    caches.open(cacheNames.runtime),
  ]);

  await Promise.all([
    evictNonCacheable(offlineCache, cacheNames.offline, manifestCachePath),
    evictNonCacheable(runtimeCache, cacheNames.runtime, manifestCachePath),
  ]);
}

// ── cache-first ──────────────────────────────────────────────────────────────

/**
 * Serve from offline cache first, then runtime cache.
 * On cache miss, fetch from network and store in runtime cache.
 *
 * Best for: static assets, fonts, images — files that rarely change.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function cacheFirst(request) {
  const cached = await getFromCache(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response);
  return response;
}

// ── network-first ────────────────────────────────────────────────────────────

/**
 * Try network first. On failure, fall back to cache (offline → runtime).
 * Successful network responses are stored in the runtime cache.
 *
 * Best for: HTML pages, user data — content that should be fresh when online.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await putInRuntime(request, response);
    return response;
  } catch {
    const cached = await getFromCache(request);
    if (cached) return cached;
    // Return a typed offline error response instead of throwing
    return new Response('Offline — no cached version available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ── network-only ─────────────────────────────────────────────────────────────

/**
 * Always fetch from network. Never read from or write to any cache.
 *
 * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkOnly(request) {
  return fetch(request);
}

// ── stale-while-revalidate ───────────────────────────────────────────────────

/**
 * Serve from cache immediately (stale), then update the cache in the background.
 * If there is no cached response, fall through to a network fetch (blocks).
 *
 * Best for: feeds, listings, content where slightly stale is acceptable.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function staleWhileRevalidate(request) {
  const cached = await getFromRuntime(request) ?? await getFromOffline(request);

  // Kick off background revalidation (fire-and-forget)
  fetch(request)
    .then(async (response) => {
      if (response.ok) await putInRuntime(request, response);
    })
    .catch(() => {/* Network error during revalidation is silently ignored */});

  // If we have a cached response, serve it immediately and revalidate in bg
  if (cached) {
    return cached;
  }

  // No cache — wait for network
  const response = await fetch(request);
  if (response.ok) await putInRuntime(request, response);
  return response;
}

// ── cache-only ───────────────────────────────────────────────────────────────

/**
 * Serve exclusively from cache. Never hit the network.
 * Returns a 503 if the resource is not cached.
 *
 * Best for: offline-only fallback resources (placeholder pages, offline.html).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function cacheOnly(request) {
  const cached = await getFromCache(request);
  if (cached) return cached;
  return new Response('Not available offline.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
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

  for (const route of routes) {
    if (matchGlob(route.match, request.url)) {
      return STRATEGY_FN[route.strategy] ?? STRATEGY_FN[defaultStrategy];
    }
  }

  return STRATEGY_FN[defaultStrategy];
}

/**
 * Handle all `fetch` events from the Service Worker.
 *
 * Filters:
 *   - Non-GET requests pass through (POST/PUT/DELETE handled natively)
 *   - Non-HTTP(S) URLs pass through (chrome-extension://, etc.)
 *
 * @param {FetchEvent} event
 */
function handleFetch(event) {
  const { request } = event;

  // Only intercept GET requests
  if (request.method !== 'GET') return;

  // Only intercept http(s) requests
  if (!request.url.startsWith('http')) return;

  const strategyFn = resolveStrategy(request);
  event.respondWith(strategyFn(request));
}

/**
 * Fetch the latest file tree manifest from the server.
 * Always bypasses browser cache (cache: 'no-store') to get the true current state.
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }>}
 */
async function fetchServerManifest() {
  const { manifestEndpoint } = getConfig();

  const response = await fetch(manifestEndpoint, {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`[NLPWA] Manifest fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Load the cached manifest snapshot from the offline cache.
 * This is written after each successful update and contains the file-hash
 * map that was last successfully applied to the cache.
 *
 * Returns null on a fresh install (no snapshot yet stored).
 *
 * @returns {Promise<{ version: string, files: Array<{ path: string, hash: string }> }|null>}
 */
async function loadCachedManifest() {
  const { caches: cacheNames, manifestCachePath } = getConfig();
  const cache = await caches.open(cacheNames.offline);
  const response = await cache.match(manifestCachePath);
  if (!response) return null;
  return response.json();
}

/**
 * Persist the server manifest as a snapshot in the offline cache.
 * Called after all update operations succeed so it becomes the reference
 * for the next update check.
 *
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} manifest
 */
async function saveCachedManifest(manifest) {
  const { caches: cacheNames, manifestCachePath } = getConfig();
  const cache = await caches.open(cacheNames.offline);

  const response = new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await cache.put(manifestCachePath, response);
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
function computeDiff(newFiles, oldFiles) {
  // Build lookup maps for O(1) access
  const oldMap = new Map((oldFiles ?? []).map(f => [f.path, f.hash]));
  const newMap = new Map(newFiles.map(f => [f.path, f.hash]));

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
 * Apply a computed diff to the caches, then run eviction and save the snapshot.
 *
 * Strategy:
 *   - added/modified  → fetch fresh and store in offline cache
 *     (individual failures are skipped with a warning; stale version stays)
 *   - removed         → delete from offline cache
 *   - runtime cache   → evict entries whose hash changed or that were removed
 *     (they will be re-fetched fresh on the next browser request)
 *   - route eviction  → evict offline + runtime entries no longer matching
 *     a caching-capable route
 *   - snapshot        → write new manifest as /_nlpwa/manifest.json
 *
 * There is intentionally no rollback. Failed fetches leave the old cached
 * file in place. The update system is self-healing: on the next check, the
 * diff will catch any still-stale files and retry.
 *
 * @param {{ added: string[], modified: string[], removed: string[] }} diff
 * @param {{ version: string, files: Array<{ path: string, hash: string }> }} newManifest
 */
async function applyDiff(diff, newManifest) {
  const { caches: cacheNames } = getConfig();

  // ── 1. Fetch and store added + modified files ───────────────────────────
  const toFetch = [...diff.added, ...diff.modified];

  await Promise.all(
    toFetch.map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) {
          await putInOffline(path, response);
          console.log(`[NLPWA] Cached: ${path}`);
        } else {
          console.warn(`[NLPWA] Skip (HTTP ${response.status}): ${path}`);
        }
      } catch (err) {
        console.warn(`[NLPWA] Skip (network error): ${path}`, err.message);
      }
    })
  );

  // ── 2. Delete removed files from offline cache ──────────────────────────
  await Promise.all(
    diff.removed.map(async (path) => {
      await deleteFromOffline(path);
      console.log(`[NLPWA] Deleted: ${path}`);
    })
  );

  // ── 3. Evict stale/removed entries from runtime cache ───────────────────
  //    Modified files: evict so fresh version is fetched on next request.
  //    Removed files:  evict so deleted resource stops being served.
  const runtimeEvictions = [...diff.modified, ...diff.removed];
  await evictFromRuntime(runtimeEvictions);

  // Also evict runtime entries that are not present in the new manifest at all
  const newPaths = new Set(newManifest.files.map(f => f.path));
  const runtimeCache = await caches.open(cacheNames.runtime);
  const runtimeKeys  = await runtimeCache.keys();
  const unknownEvictions = runtimeKeys
    .map(r => new URL(r.url).pathname)
    .filter(p => !newPaths.has(p));
  await evictFromRuntime(unknownEvictions);

  // ── 4. Route-aware eviction on both caches ──────────────────────────────
  await evictByRoute();

  // ── 5. Persist new manifest snapshot ────────────────────────────────────
  await saveCachedManifest(newManifest);

  console.log(
    `[NLPWA] Update complete → v${newManifest.version} ` +
    `(+${diff.added.length} added, ~${diff.modified.length} modified, ` +
    `-${diff.removed.length} removed)`
  );
}

/**
 * Parse a semver string into its numeric components.
 * Non-numeric pre-release suffixes are ignored.
 *
 * @param {string} version  e.g. '1.4.0'
 * @returns {{ major: number, minor: number, patch: number }}
 */
function parse(version) {
  const parts = String(version).split('.').map(s => parseInt(s, 10) || 0);
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
  };
}

/**
 * Compare two semver strings.
 *
 * @returns {-1|0|1}  -1 if a < b, 0 if equal, 1 if a > b
 */
function compare(a, b) {
  const av = parse(a);
  const bv = parse(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (av[key] < bv[key]) return -1;
    if (av[key] > bv[key]) return  1;
  }
  return 0;
}

/**
 * Returns true if serverVersion is strictly newer than clientVersion.
 *
 * @param {string} serverVersion
 * @param {string} clientVersion
 */
function isNewer(serverVersion, clientVersion) {
  return compare(serverVersion, clientVersion) > 0;
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
 * Run a complete update check cycle:
 *
 *   1. Fetch /api/manifest/latest
 *   2. Version comparison (short-circuit if up to date)
 *   3. Hash diff against cached manifest
 *   4. Apply diff (fetch changed, delete removed, evict stale)
 *   5. Broadcast UPDATE_READY to all clients
 *
 * This function is safe to call concurrently — a module-level lock
 * prevents overlapping update runs.
 *
 * @returns {Promise<{ updated: boolean, version?: string }>}
 */
let _updateInProgress = false;

async function checkForUpdate() {
  if (_updateInProgress) {
    console.log('[NLPWA] Update already in progress, skipping.');
    return { updated: false };
  }

  _updateInProgress = true;

  try {
    const config = getConfig();

    // ── Step 1: Fetch server manifest ──────────────────────────────────────
    let serverManifest;
    try {
      serverManifest = await fetchServerManifest();
    } catch (err) {
      console.warn('[NLPWA] Cannot reach manifest endpoint:', err.message);
      return { updated: false };
    }

    // ── Step 2: Version check ──────────────────────────────────────────────
    if (!isNewer(serverManifest.version, config.version)) {
      console.log(`[NLPWA] Already up to date (v${config.version})`);
      await broadcast({ type: MESSAGE_TYPES.NO_UPDATE, version: config.version });
      return { updated: false };
    }

    console.log(`[NLPWA] Update available: v${config.version} → v${serverManifest.version}`);

    // ── Step 3: Hash diff ──────────────────────────────────────────────────
    const cachedManifest = await loadCachedManifest();
    const diff = computeDiff(serverManifest.files, cachedManifest?.files ?? null);

    const hasChanges = diff.added.length + diff.modified.length + diff.removed.length > 0;

    // ── Step 4: Apply diff (or just save snapshot if only version changed) ─
    if (hasChanges) {
      await applyDiff(diff, serverManifest);
    } else {
      // Version bumped but all file hashes are identical → just save snapshot
      await saveCachedManifest(serverManifest);
      console.log(`[NLPWA] Version updated (no file changes): v${serverManifest.version}`);
    }

    // ── Step 5: Notify clients ─────────────────────────────────────────────
    await broadcast({
      type:    MESSAGE_TYPES.UPDATE_READY,
      version: serverManifest.version,
    });

    return { updated: true, version: serverManifest.version };

  } finally {
    _updateInProgress = false;
  }
}

/**
 * Start automatic update polling based on config.updateCheckInterval.
 * No-op if updateCheckInterval is 0 (manual-only mode).
 */
function startUpdatePolling() {
  const { updateCheckInterval } = getConfig();
  if (!updateCheckInterval) return;

  const intervalMs = updateCheckInterval;
  console.log(`[NLPWA] Update polling every ${intervalMs / 1000}s`);

  setInterval(() => {
    checkForUpdate().catch(err => console.error('[NLPWA] Update check error:', err));
  }, intervalMs);
}

/**
 * Initialize the NLPWA Service Worker.
 *
 * Call this once at the top of your sw.js:
 *
 *   import { initSW } from './nlpwa/src/sw/index.js';
 *   // or from the built file:
 *   // importScripts('/nlpwa.sw.js');
 *
 *   initSW({
 *     version: '1.0.0',
 *     precache: ['/', '/index.html', '/app.js'],
 *     routes: [
 *       { match: '/api/**',    strategy: 'network-only' },
 *       { match: '/assets/**', strategy: 'cache-first'  },
 *       { match: '**',         strategy: 'network-first'},
 *     ],
 *   });
 *
 * @param {Object} userConfig  see src/sw/config/defaults.js for all options
 */
function initSW(userConfig = {}) {
  const config = initConfig(userConfig);

  // ── install ────────────────────────────────────────────────────────────────
  // Pre-cache the app shell. skipWaiting() ensures the new SW takes over
  // immediately without waiting for existing tabs to close.
  self.addEventListener('install', (event) => {
    console.log(`[NLPWA] Installing v${config.version}`);
    event.waitUntil(
      precacheFiles()
        .then(() => self.skipWaiting())
        .catch(err => console.error('[NLPWA] Install error:', err))
    );
  });

  // ── activate ───────────────────────────────────────────────────────────────
  // clients.claim() lets the new SW control already-open tabs immediately.
  // Update polling starts here so it doesn't run in an uncontrolled SW.
  self.addEventListener('activate', (event) => {
    console.log(`[NLPWA] Activated v${config.version}`);
    event.waitUntil(
      self.clients.claim().then(() => {
        startUpdatePolling();
        // Run an initial update check on every activation
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
    if (event.data?.type === MESSAGE_TYPES.CHECK_UPDATE) {
      event.waitUntil(checkForUpdate());
    }
  });
}

export { initSW };
