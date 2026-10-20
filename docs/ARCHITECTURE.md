# NLPWA — Architecture
## Overview

NLPWA is a Service Worker framework with a decoupled architecture:

| Context | File | Role |
|---|---|---|
| Service Worker thread | `out/sw.js` | Intercepts fetches, manages caches, applies delta updates |
| Runtime Configuration | `config.js` → `config.json` | Dynamic route rules & precache list; stored in `offline` cache |
| Main thread (browser) | `out/client.js` (IIFE) / `out/client.esm.js` (ES module) | Registers the SW, listens for updates, shows update UI |
| Build Tool / CLI | `bin/nlpwa.js` / Rollup | Derives content-hash version, tracks offline files & config, emits update API |

The Service Worker thread and client communicate via `postMessage`.
Runtime configuration is completely decoupled from `sw.js` and loaded dynamically from the `offline` cache.

---

## Module Map

```
src/
├── shared/                         ← Shared by SW, client, and build tool
│   ├── async.js                    mapConcurrent() bounded async concurrency runner
│   ├── time.js                     parseDurationMs(), resolveMaxAgeMs(), isResponseExpired()
│   ├── constants.js                Cache names (OFFLINE, RUNTIME, META), message types, strategies
│   ├── hash.js                     sha256Hex(), hashMatches()
│   ├── glob.js                     Glob URL pattern matching (*, **, ?)
│   ├── version.js                  Semver comparison & incrementPatch (isNewer, compare)
│   ├── url.js                      resolvePathWithBase(), resolveUpdateEndpoints()
│   └── logger.js                   Tiered logging utility (silent, error, warn, info, debug)
│
├── sw/                             ← Runs in Service Worker thread
│   ├── index.js                    Entry orchestrator: initSW(config) — wires event handlers
│   ├── logger.js                   SW-scoped loggers (error, warn, log, debug)
│   ├── standalone.js               Auto-init classic/module worker entry (built to out/sw.js)
│   ├── events/                     ← Modular SW lifecycle event listeners
│   │   ├── install.js              Install event: precacheFiles() and skipWaiting()
│   │   ├── activate.js             Activate event: clients.claim(), navigationPreload, pin seeding
│   │   ├── message.js              Message dispatcher table for all postMessage actions
│   │   ├── push.js                 Push notifications and silent background update triggers
│   │   └── sync.js                 Periodic background sync update checks
│   ├── config/
│   │   ├── defaults.js             Default config values (SW version, endpoints, paths, logLevel)
│   │   ├── schema.js               Config validation (returns error strings)
│   │   └── index.js                loadConfigFromCache(), updateActiveConfig(), ensureConfigReady()
│   ├── cache/                      ← Segmented storage subsystem
│   │   ├── meta/                   Low-level JSON metadata & atomic pointers
│   │   │   ├── store.js            readMeta(), writeMeta(), deleteMeta() (nlpwa-meta CacheStorage)
│   │   │   ├── active.js           Active version pointer (getActive, setActive, clearActive)
│   │   │   ├── staged.js           Staged version pointer (getStaged, setStaged, clearStaged)
│   │   │   ├── client-pins.js      Per-client tab isolation (pinClient, unpinClient, pruneClientPins)
│   │   │   └── lock.js             Cooperative operation lock (Web Locks API + memory mutex)
│   │   ├── offline/                Precache & app shell store
│   │   │   ├── store.js            getFromOffline(), putInOffline(), deleteFromOffline()
│   │   │   ├── aliases.js          matchWithAliases() — clean URLs, directory index, subpath bases
│   │   │   └── install.js          precacheFiles() — install-time stage + commit (manifest-driven)
│   │   ├── runtime/                Dynamic lazy cache store
│   │   │   ├── store.js            getFromRuntime(), putInRuntime(), evictFromRuntime(), clearAllCaches()
│   │   │   └── keys.js             cleanTrackingParams() — strips marketing/analytics query parameters
│   │   ├── eviction/               Storage inspection & eviction policies
│   │   │   ├── quota.js            getStorageQuotaInfo() using navigator.storage.estimate()
│   │   │   ├── size.js             resolveByteSize() for parsing bytes, KB, MB, GB, '50MB'
│   │   │   ├── policies.js         cleanRuntimeCache() (LRU, largest, max-age, quota, pattern, all)
│   │   │   └── route-cleaner.js    evictByRoute(), isCacheableUrl() — route-aware invalidation
│   │   ├── tag.js                  tagResponse() — injects X-Cache-Status headers
│   │   └── index.js                Barrel re-export
│   ├── fetch/                      ← Fetch interception & request pipeline
│   │   ├── strategies/             Individual caching strategy implementations
│   │   │   ├── cache-first.js      Cache-First algorithm (offline → runtime → network)
│   │   │   ├── network-first.js    Network-First algorithm (network race with timeout → cache)
│   │   │   ├── network-only.js     Network-Only algorithm (pure network pass-through)
│   │   │   ├── stale-while-revalidate.js Stale-While-Revalidate algorithm (serve cached, refresh bg)
│   │   │   ├── cache-only.js       Cache-Only algorithm (strictly cache, offline fallback on miss)
│   │   │   ├── context.js          Shared execution helpers (performFetch, safePutInRuntime, etc.)
│   │   │   └── index.js            Strategy registry & re-exports
│   │   ├── router.js               resolveStrategy(request), matchRoute(url, routes, config)
│   │   ├── navigation.js           isNavigationFallbackAllowed() — allowlist/denylist matching
│   │   ├── plugins.js              Workbox-compatible plugin lifecycle hooks runner
│   │   ├── range.js                createRangeResponse() — 206 Partial Content byte slicing
│   │   └── index.js                handleFetch(event) — SW fetch event handler
│   └── update/                     ← Atomic OTA update engine
│       ├── staging/                Update staging pipeline
│       │   ├── verifier.js         isAlreadyStaged() — SHA-256 integrity & oversized file rules
│       │   ├── fetcher.js          fetchVerified() — streaming fetch with timeout & hash verification
│       │   └── orchestrator.js     stageUpdate() — builds delta cache, copies unchanged, verifies delta
│       ├── diff.js                 computeDiff(newFiles, oldFiles) → { added, modified, removed }
│       ├── manifest.js             fetchServerVersion (Tier 1), fetchServerInfo (Tier 2), save snapshot
│       ├── commit.js               commitStaged() — one-write atomic switch to staged version
│       ├── status.js               Observable update status tracker (idle, checking, staging, ready)
│       └── index.js                checkForUpdate() orchestration
│
├── client/                         ← Runs in main browser thread (built to out/client.js / client.esm.js)
│   ├── index.js                    Clean public API entry point
│   ├── registration.js             register(swUrl, options), unregister(scope), onUpdateApplied()
│   ├── form-guard.js               isUserEditing() — detects active form inputs to protect unsaved work
│   ├── polling.js                  setupFocusPolling(), setupIntervalPolling(), setupPeriodicSync()
│   ├── messaging.js                sendToSW(), onSWMessage(), getVersion(), getStatus(), requestFromSW()
│   ├── cache-manager.js            getCacheInfo(), cleanupRuntimeCache() — quota & cache management
│   ├── update-ui.js                onUpdateReady(), onStagingProgress(), applyUpdate()
│   └── logger.js                   Client logger with configurable log levels
│
├── cli/                            ← Modular CLI engine (executed via bin/nlpwa.js)
│   ├── index.js                    CLI argument parser & command router (runCLI)
│   ├── commands/
│   │   ├── init.js                 cmdInit() — project scaffolding & drop-in file installer
│   │   ├── add.js                  cmdAdd() — installs optional official plugins into project
│   │   ├── update.js               cmdUpdate() — manifest generation & update endpoint emitter
│   │   ├── status.js               cmdStatus() — inspect deployed config and tracked files
│   │   └── generate-offline.js     cmdGenerateOffline() — standalone offline.html page generator
│   ├── core/
│   │   ├── manifest.js             hashFile(), computeManifestHash(), deriveAppVersion(), collectTrackedFiles()
│   │   └── config.js               findConfigFile(), loadConfig(), syncSourceConfigVersion()
│   └── ui/
│       └── terminal.js             ANSI color formatting, printBanner(), printHelp()
│
├── plugins/                        ← Official modular plugins
│   └── sync/                       Background Sync & Offline Mutation (IndexedDB + cross-browser fallback)
│       ├── idb.js                  Zero-dependency IndexedDB wrapper & request serializer
│       ├── queue.js                SyncQueue — FIFO replay queue with retention pruning & retries
│       ├── sw.js                   BackgroundSyncPlugin — SW fetchDidFail & sync event listeners
│       ├── client.js               SyncClient — window API & autoSyncOnOnline fallback
│       ├── constants.js            Typed message constants
│       └── index.js                Barrel re-export
│
├── bin/
│   ├── nlpwa.js                    Thin executable shim delegating to src/cli/index.js
│   └── build-utils.js              Re-export adapter for build utilities
│
├── rollup-plugin.js                ← Bundler plugin for Vite / Rollup integration
├── webpack-plugin.js               ← Bundler plugin for Webpack integration
└── src/config.js                   ← Starter config template (emits out/api/update/config.json)
```

---

## Cache Storage Layout

```
CacheStorage
├── nlpwa-meta                      Two tiny pointers (the atomic commit point)
│   ├── /_nlpwa/active.json         { cache, version, swVersion } - which offline cache is live
│   └── /_nlpwa/staged.json         { cache, version, complete, evict, ... } - update waiting to go live
├── offline@1.0.1-k3x9              ACTIVE version: app shell + runtime config + snapshot
│   ├── /api/update/config.json     Runtime config (routes, precache, endpoints)
│   └── /_nlpwa/snapshot.json       Hash map of this version; written last = "complete"
├── offline@1.0.2-m1q7              STAGED version (only exists while an update waits)
└── runtime                         Lazily cached responses (filled by fetch strategies)
```

### Why a cache per version plus a pointer?

- **Atomic**: the Cache API cannot rename or move caches. Building the next version in its own cache and flipping one pointer means a crash, a dropped connection or a failed download can never leave a half-updated app.
- **Consistent pages**: the switch happens on a navigation request (or `APPLY_UPDATE`), never in the middle of a page load, so one page is not served partly from two versions.
- **Cheap deltas**: unchanged files are copied from the active cache locally; only changed files use the network, and each is hash-verified.

### Why store the config & snapshot inside the versioned cache?

- **Zero network roundtrips at fetch time**: The SW loads `/api/update/config.json` directly from the active cache.
- **OTA Route updates**: Updating `nlpwa.config.js` does NOT require a byte-level reinstall of `sw.js`. The new `/api/update/config.json` is staged with the rest of the version and its routes apply when that version goes live.
- **Persistence**: Survives SW restarts without requiring IndexedDB.

---

## Data Flow

### 1. SW Install

```
install event
  └─ precacheFiles()
       ├─ Normal path: fetchServerInfo() → stageUpdate() → commitStaged() (manifest-driven with SHA-256 integrity)
       │    └─ writes snapshot to staged cache and commits immediately on first install
       └─ Fallback path (when `nlpwa update` has not been run): precacheWithoutManifest()
            └─ fetches config.json and precache list directly; subsequent update check builds hashed snapshot
  └─ self.skipWaiting()
```

### 2. SW Activate

```
activate event
  └─ event.waitUntil(...)         ← fast local operations only (<3ms, zero network I/O)
       ├─ self.clients.claim()
       ├─ sweepOrphanCaches()     ← cleans up unreferenced staging caches
       └─ loadConfigFromCache()   ← ensures in-memory routes are ready
```

### 3. Fetch Interception

```
fetch event (GET, http/https only)
  └─ ensureConfigReady()
  └─ if request.mode === 'navigate':
       └─ commitIfReady()     ← switches to staged update before serving new page!
  └─ resolveStrategy(request)
       ├─ if isManifestFile(request.url) (in precache):
       │    └─ return cache-first (bound to active offline cache; guarantees atomicity)
       └─ otherwise: iterate active config.routes (hydrated from offline cache) top-to-bottom
            ├─ matchGlob(route.match, request.url) → return matched strategy function
            └─ no match → return defaultStrategy function
  └─ event.respondWith(strategyFn(request, event))
```

### 4. Two-Tier Update Check & Atomic Staging

```
checkForUpdate()
  │
  ├─ [guard] _updateInProgress lock — prevents concurrent runs
  │
  ├─ Tier 1: fetchServerVersion()
  │    └─ GET /api/update/version.json  { cache: 'no-store' }
  │    └─ server.version === cached.version (strict equality)?
  │         └─ equal & no SW engine change: STOP (no heavy downloads)
  │         └─ unequal: proceed to Tier 2 (supports 1.0.0-<hash> and rollbacks)
  │
  ├─ Tier 2: fetchServerInfo()
  │    └─ GET /api/update/info.json  { cache: 'no-store' }
  │
  ├─ computeDiff(server.files, cached.files)
  │    └─ Map-based comparison → { added[], modified[], removed[] }
  │
  ├─ stageUpdate(manifest, diff) in separate offline@<version>-<id> cache
  │    ├─ reuse files already verified in partial staging cache (resume)
  │    ├─ copy unchanged files locally from active cache (zero network bytes)
  │    ├─ fetch added + modified files with { cache: 'no-store' }
  │    ├─ broadcast STAGING_PROGRESS to clients ({ loaded, total, percent, file })
  │    ├─ auto-recover on QuotaExceededError: evicts runtime cache and retries
  │    ├─ verify SHA-256 against manifest hashes (config.verifyHashes)
  │    │    └─ Note: same-origin hashes guard against network corruption, captive portals, and partial deploys (not compromised origin)
  │    ├─ if any file fails: remains incomplete, resumes on next check (exponential backoff after 5 attempts)
  │    ├─ write snapshot to staged cache once all files verified (marks staging complete)
  │    └─ record staged pointer in nlpwa-meta (/_nlpwa/staged.json)
  │
  └─ broadcast({ type: 'UPDATE_READY', version })
       └─ clients.matchAll() → client.postMessage(...)

Commit Phase: commitStaged() (triggered on navigation or APPLY_UPDATE message):
  ├─ atomically switch active pointer in nlpwa-meta (/_nlpwa/active.json)
  ├─ clear staged pointer (invalidates memoised _stagedPromise)
  ├─ reload config.json into in-memory router
  ├─ evict modified/removed entries from runtime cache
  ├─ evictByRoute() delegating to matchRoute
  └─ prune old offline caches (preserving v(N-1) if retainPreviousVersionCache: true)
```

### 5. Client Update Flow

```
SW postMessage({ type: 'UPDATE_READY', version })
  └─ onSWMessage handler in src/client/registration.js
       ├─ options.onUpdateReady({ version })  ← user callback
       ├─ document.dispatchEvent('nlpwa:update-ready')
       └─ options.autoReload → deferred to prompt if user is editing inputs, else applyUpdate

User clicks "Refresh" (or calls NLPWAClient.applyUpdate()):
  └─ NLPWAClient.applyUpdate()
       └─ sendToSW({ type: 'APPLY_UPDATE' }) → awaits UPDATE_APPLIED reply
       └─ window.location.reload()
            └─ browser navigation request commits staged cache and serves new version
```

---

## Route-Aware Eviction (Option A)

A cached file is evicted when its URL no longer matches any **caching-capable** route.

**Caching-capable strategies:**
- `cache-first`
- `network-first`
- `stale-while-revalidate`
- `cache-only`

**Not caching-capable:**
- `network-only` — responses are never stored

**Example:** If you change a route from `cache-first` to `network-only`, all previously cached responses for that URL pattern are evicted on the next update.

Eviction runs on **both** caches after every successful update application.

---

## Runtime Cache Cleanup & Quota Management

NLPWA includes an intelligent cleanup manager for the dynamic `runtime` cache:
- **Storage Quota Detection**: Reads `navigator.storage.estimate()` to inspect storage usage and quota limits.
- **Cache Inspection**: `getCacheInfo()` queries the SW to return total entries, estimated bytes, and quota metrics.
- **Eviction Strategies**: Supports `largest` (evicts largest files first via `X-NLPWA-Content-Length`), `lru` (least-recently-used via `X-NLPWA-Cached-At`), `max-age` (evicts expired entries), `quota` (evicts until storage is under quota threshold), `pattern` (glob match eviction), and `all` (full wipe).
- **Flexible Limits**: Supports limits by item count (`maxEntries`), total size (`maxTotalMB`, `maxTotalBytes`), or individual item bounds (`minItemBytes`, `maxItemBytes`, string units like `'50MB'`).

---

## Concurrency Model & Locking

1. **Atomic Operation Lock (`withLock`)**:
   Staging and committing must not overlap. NLPWA uses the standard Web Locks API (`navigator.locks.request('nlpwa-operation-lock', { ifAvailable: true })`) across concurrent tabs and worker threads, falling back gracefully to in-memory cooperative locking (`tryAcquire` / `release`).
2. **Update Check Throttling**:
   A boolean lock (`_updateInProgress`) prevents overlapping `checkForUpdate()` runs from intervals, tab focus, or manual calls.
3. **Cache Cleanup Serialization**:
   Concurrent `cleanRuntimeCache()` calls are queued sequentially via `_cleanupPromise`, ensuring quota calculations and deletions never collide.
4. **Pointer Memoization**:
   Active and staged metadata pointers (`_activePromise` and `_stagedPromise`) are cached in memory. Reads on navigation bypass `CacheStorage` I/O, updating instantly upon `setActive()`, `setStaged()`, or `clearStaged()`.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| SW vs. App Versioning | Separated (SW manual, App content-hash derived) | App updates don't cause browser byte-level SW reinstalls. Identical rebuilds produce identical hashes, eliminating watch loops and false update alerts |
| Dynamic Config | `config.js` → `config.json` in `offline` cache | Route and strategy changes update OTA without touching SW code |
| File Tracking Scope | Offline files (`config.precache`) + `config.json` only | Runtime assets are cached lazily; keeps manifest tiny & focused |
| Two-Tier Update API | `/version.json` (check) + `/info.json` (manifest) | Polling costs ~20 bytes instead of pulling full file trees |
| Cache layout | `nlpwa-meta` + `offline@<version>-<id>` + `runtime` | Atomic active pointer ensures zero mixed-version states; old caches pruned on commit |
| Manifest storage | Cache snapshot at `/_nlpwa/snapshot.json` | Survives SW restarts, marks cache complete, no IndexedDB required |
| Diff computation | Client-side (SW) | Server stays stateless; no complex delta calculations |
| Eviction rule | Route-strategy-aware | Routes define cacheability; not file presence |
| Atomic Staging & Resumption | Separate staging cache + SHA-256 verification | Downloads stage in a separate cache; live app stays untouched until atomic commit. Failed downloads resume, never committing mixed/broken files |
| SW format | ES module (`type: 'module'`) | Modern browsers support it; readable output |
| Client format | IIFE (`out/client.js`, global `NLPWAClient`) + ES module (`out/client.esm.js`) | Drop-in `<script>` tag or bundler import |
