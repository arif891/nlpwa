# NLPWA — Architecture
## Overview

NLPWA is a Service Worker framework with a decoupled architecture:

| Context | File | Role |
|---|---|---|
| Service Worker thread | `build/sw.js` | Intercepts fetches, manages caches, applies delta updates |
| Runtime Configuration | `config.js` → `config.json` | Dynamic route rules & precache list; stored in `offline` cache |
| Main thread (browser) | `build/client.js` | Registers the SW, listens for updates, shows update UI |
| Build Tool / CLI | `bin/nlpwa.js` / Rollup | Auto-increments patch version, tracks offline files & config, emits update API |

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
├── client/                         ← Runs in main browser thread (built to build/client.js)
│   ├── register.js                 register(swUrl, options) — SW registration & client SDK entry
│   ├── messaging.js                sendToSW(), onSWMessage(), requestUpdateCheck()
│   └── update-ui.js                onUpdateReady() → callback + CustomEvent, applyUpdate()
│
├── rollup-plugin.js                ← Bundler plugin for Vite / Rollup integration
└── config.js                       ← Starter config template (built to build/config.js)
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
       └─ fetch('/config.json', { cache: 'no-store' })
            └─ caches.open('offline').put('/config.json', response)
            └─ updateActiveConfig(runtimeConfig)  ← hydrates routes & precache
       └─ cache.add(url) for each url in config.precache
  └─ self.skipWaiting()
```

### 2. SW Activate

```
activate event
  └─ self.clients.claim()
  └─ loadConfigFromCache()    ← ensures in-memory routes are ready
  └─ startUpdatePolling()     ← sets interval timer
  └─ checkForUpdate()         ← runs initial two-tier check
```

### 3. Fetch Interception

```
fetch event (GET, http/https only)
  └─ resolveStrategy(request)
       └─ iterate active config.routes (hydrated from offline cache) top-to-bottom
            └─ matchGlob(route.match, request.url)
                 └─ first match → return strategy function
                 └─ no match   → return defaultStrategy function
  └─ event.respondWith(strategyFn(request))
```

### 4. Two-Tier Update Check

```
checkForUpdate()
  │
  ├─ [guard] _updateInProgress lock — prevents concurrent runs
  │
  ├─ Tier 1: fetchServerVersion()
  │    └─ GET /api/update/version  { cache: 'no-store' }
  │    └─ isNewer(server.version, cached.version)?
  │         └─ false & no SW engine change: STOP (no heavy downloads)
  │
  ├─ Tier 2: fetchServerManifest()
  │    └─ GET /api/update/info  { cache: 'no-store' }
  │
  ├─ computeDiff(server.files, cached.files)
  │    └─ Map-based comparison → { added[], modified[], removed[] }
  │
  ├─ applyDiff(diff, serverManifest)
  │    ├─ fetch added + modified → putInOffline()
  │    │    └─ if /config.json in diff: reload in-memory routes dynamically!
  │    ├─ deleteFromOffline() for removed
  │    ├─ evictFromRuntime() for modified + removed
  │    ├─ evictByRoute() using updated routes
  │    └─ saveCachedManifest(newManifest)
  │
  └─ broadcast({ type: 'UPDATE_READY', version })
       └─ clients.matchAll() → client.postMessage(...)
```

### 5. Client Update Flow

```
SW postMessage({ type: 'UPDATE_READY', version })
  └─ onSWMessage handler in register.js
       ├─ options.onUpdateReady({ version })  ← user callback
       ├─ document.dispatchEvent('nlpwa:update-ready')
       └─ options.autoReload → window.location.reload()

User clicks "Refresh"
  └─ NLPWAClient.applyUpdate()
       └─ window.location.reload()
            └─ browser re-requests resources
                 └─ SW serves from updated offline cache
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

## Concurrency Model

The SW is single-threaded, but `checkForUpdate()` is async. A boolean lock (`_updateInProgress`) prevents two overlapping update runs (e.g. if the interval fires while a previous check is still in flight). The lock is released in a `finally` block so it always resets even on error.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| SW vs. App Versioning | Separated (SW manual, App build-managed) | App updates don't cause browser byte-level SW reinstalls |
| Dynamic Config | `config.js` → `config.json` in `offline` cache | Route and strategy changes update OTA without touching SW code |
| File Tracking Scope | Offline files (`config.precache`) + `config.json` only | Runtime assets are cached lazily; keeps manifest tiny & focused |
| Two-Tier Update API | `/version` (check) + `/info` (manifest) | Polling costs ~20 bytes instead of pulling full file trees |
| Cache layout | `offline` + `runtime` only | No versioned cache proliferation |
| Manifest storage | Cache entry at `/_nlpwa/manifest.json` | No IndexedDB; survives SW restarts |
| Diff computation | Client-side (SW) | Server stays stateless; no complex delta calculations |
| Eviction rule | Route-strategy-aware | Routes define cacheability; not file presence |
| Update failure | Skip & log (no rollback) | Self-healing on next check; simpler code |
| SW format | ES module (`type: 'module'`) | Modern browsers support it; readable output |
| Client format | IIFE (`NLPWAClient`) | Drop-in `<script>` tag; no bundler required |
