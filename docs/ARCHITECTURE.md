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
├── shared/                         ← Shared by both SW, client, and build tool
│   ├── constants.js                Cache names, message types, strategy names
│   ├── hash.js                     sha256Hex(), hashMatches()
│   ├── glob.js                     Glob URL pattern matching (*, **, ?)
│   └── version.js                  Semver comparison & incrementPatch (isNewer, compare)
│
├── sw/                             ← Runs in Service Worker thread
│   ├── index.js                    Entry: initSW(config) — wires all lifecycle events
│   ├── config/
│   │   ├── defaults.js             Default config values (SW version, endpoints, paths)
│   │   ├── schema.js               Config validation (returns error strings)
│   │   └── index.js                loadConfigFromCache(), updateActiveConfig(), getUpdateEndpoints()
│   ├── cache/
│   │   ├── store.js                nlpwa-meta pointers (active / staged), lock, old-cache cleanup
│   │   ├── install.js              precacheFiles() — install-time stage + commit (manifest-driven)
│   │   ├── runtime.js              get/put/delete helpers for offline + runtime caches, clearAllCaches()
│   │   ├── cleanup.js              cleanRuntimeCache(), getStorageQuotaInfo() — quota & size-based eviction
│   │   ├── evict.js                evictByRoute() — route-aware eviction on route changes
│   │   └── index.js                Barrel re-export
│   ├── fetch/
│   │   ├── strategies.js           5 strategy functions (tagged with X-Cache-Status)
│   │   ├── router.js               resolveStrategy(request) — glob route matching
│   │   └── index.js                handleFetch(event) — SW fetch event handler
│   └── update/
│       ├── manifest.js             fetchServerVersion (Tier 1), fetchServerManifest (Tier 2), save snapshot
│       ├── diff.js                 computeDiff(newFiles, oldFiles) → { added, modified, removed }
│       ├── stage.js                stageUpdate() — builds + hash-verifies the new version in a separate cache
│       ├── commit.js               commitStaged() — one-write switch to the staged version
│       └── index.js                checkForUpdate() with two-tier checks and concurrency lock
│
├── client/                         ← Runs in main browser thread (built to out/client.js)
│   ├── register.js                 register(swUrl, options) — SW registration & client SDK entry
│   ├── messaging.js                sendToSW(), onSWMessage(), requestUpdateCheck()
│   ├── cache-manager.js            getCacheInfo(), cleanupRuntimeCache() — quota & cache management
│   └── update-ui.js                onUpdateReady() → callback + CustomEvent, applyUpdate()
│
├── rollup-plugin.js                ← Bundler plugin for Vite / Rollup integration
└── config.js                       ← Starter config template (emits out/config.json)
```

---

## Cache Storage Layout

```
CacheStorage
├── nlpwa-meta                      Two tiny pointers (the atomic commit point)
│   ├── /_nlpwa/active.json         { cache, version, swVersion } - which offline cache is live
│   └── /_nlpwa/staged.json         { cache, version, complete, evict, ... } - update waiting to go live
├── offline@1.0.1-k3x9              ACTIVE version: app shell + runtime config + snapshot
│   ├── /config.json                Runtime config (routes, precache, endpoints)
│   └── /_nlpwa/snapshot.json       Hash map of this version; written last = "complete"
├── offline@1.0.2-m1q7              STAGED version (only exists while an update waits)
└── runtime                         Lazily cached responses (filled by fetch strategies)
```

### Why a cache per version plus a pointer?

- **Atomic**: the Cache API cannot rename or move caches. Building the next version in its own cache and flipping one pointer means a crash, a dropped connection or a failed download can never leave a half-updated app.
- **Consistent pages**: the switch happens on a navigation request (or `APPLY_UPDATE`), never in the middle of a page load, so one page is not served partly from two versions.
- **Cheap deltas**: unchanged files are copied from the active cache locally; only changed files use the network, and each is hash-verified.

### Why store the config & snapshot inside the versioned cache?

- **Zero network roundtrips at fetch time**: The SW loads `/config.json` directly from the active cache.
- **OTA Route updates**: Updating `config.js` does NOT require a byte-level reinstall of `sw.js`. The new `config.json` is staged with the rest of the version and its routes apply when that version goes live.
- **Persistence**: Survives SW restarts without requiring IndexedDB.

---

## Data Flow

### 1. SW Install

```
install event
  └─ precacheFiles()
       └─ fetch('/config.json', { cache: 'no-store' }) & app shell (or update manifest)
       └─ stages initial version in offline@<version>-<id> cache
       └─ writes snapshot to staged cache (marks cache complete)
       └─ commits immediately via setActive() and hydrates active config
  └─ self.skipWaiting()
```

### 2. SW Activate

```
activate event
  ├─ event.waitUntil(...)         ← fast local operations only (<3ms, zero network I/O)
  │    ├─ self.clients.claim()
  │    ├─ sweepOrphanCaches()     ← cleans up unreferenced staging caches
  │    └─ loadConfigFromCache()   ← ensures in-memory routes are ready
  │
  └─ checkForUpdate()             ← runs in background without blocking activate or fetch events
```

### 3. Fetch Interception

```
fetch event (GET, http/https only)
  └─ ensureConfigReady()
  └─ if request.mode === 'navigate':
       └─ commitIfReady()     ← switches to staged update before serving new page!
  └─ resolveStrategy(request)
       └─ iterate active config.routes (hydrated from offline cache) top-to-bottom
            └─ matchGlob(route.match, request.url)
                 └─ first match → return strategy function
                 └─ no match   → return defaultStrategy function
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
  ├─ Tier 2: fetchServerManifest()
  │    └─ GET /api/update/info.json  { cache: 'no-store' }
  │
  ├─ computeDiff(server.files, cached.files)
  │    └─ Map-based comparison → { added[], modified[], removed[] }
  │
  ├─ stageUpdate(manifest, diff) in separate offline@<version>-<id> cache
  │    ├─ reuse files already verified in partial staging cache (resume)
  │    ├─ copy unchanged files locally from active cache (zero network bytes)
  │    ├─ fetch added + modified files with { cache: 'no-store' }
  │    ├─ verify SHA-256 against manifest hashes (config.verifyHashes)
  │    │    └─ Note: same-origin hashes guard against network corruption, captive portals, and partial deploys (not compromised origin)
  │    ├─ if any file fails: remains incomplete, resumes on next check (exponential backoff after 5 attempts)
  │    ├─ write snapshot to staged cache once all files verified (marks staging complete)
  │    └─ record staged pointer in nlpwa-meta (/_nlpwa/staged.json)
  │
  └─ broadcast({ type: 'UPDATE_READY', version, partial })
       └─ clients.matchAll() → client.postMessage(...)

Commit Phase: commitStaged() (triggered on navigation or APPLY_UPDATE message):
  ├─ atomically switch active pointer in nlpwa-meta (/_nlpwa/active.json)
  ├─ clear staged pointer
  ├─ reload config.json into in-memory router
  ├─ evict modified/removed entries from runtime cache
  ├─ evictByRoute() using updated routes
  └─ prune old offline caches
```

### 5. Client Update Flow

```
SW postMessage({ type: 'UPDATE_READY', version, partial })
  └─ onSWMessage handler in register.js
       ├─ options.onUpdateReady({ version, partial })  ← user callback
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
- **Eviction Strategies**: Supports `lru` (least-recently-used via `X-NLPWA-Cached-At`), `fifo` (first-in-first-out), and `largest` (evicts largest items first via `X-NLPWA-Content-Length`).
- **Flexible Limits**: Supports limits by item count (`maxEntries`), total size (`maxTotalMB`, `maxTotalBytes`), or individual item bounds (`minItemBytes`, `maxItemBytes`, string units like `'50MB'`).

---

## Concurrency Model

The SW is single-threaded, but `checkForUpdate()` is async. A boolean lock (`_updateInProgress`) prevents two overlapping update runs (e.g. if the interval fires while a previous check is still in flight). The lock is released in a `finally` block so it always resets even on error.

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
