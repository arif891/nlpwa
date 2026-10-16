# NLPWA — Architecture

## Overview

NLPWA is a Service Worker framework. It runs in two contexts:

| Context | File | Role |
|---|---|---|
| Service Worker thread | `build/sw.js` | Intercepts fetches, manages caches, applies updates |
| Main thread (browser) | `build/client.js` | Registers the SW, polls for updates, shows update UI |

The two contexts communicate exclusively via `postMessage`.

---

## Module Map

```
src/
├── shared/                         ← Shared by both SW and client
│   ├── constants.js                Cache names, message types, strategy names
│   ├── glob.js                     Glob URL pattern matching (*, **, ?)
│   └── version.js                  Semver comparison (isNewer, compare)
│
├── sw/                             ← Runs in Service Worker thread
│   ├── index.js                    Entry: initSW(config) — wires all lifecycle events
│   ├── config/
│   │   ├── defaults.js             Default config values
│   │   ├── schema.js               Config validation (returns error strings)
│   │   └── index.js                initConfig() / getConfig() singleton
│   ├── cache/
│   │   ├── install.js              precacheFiles() — pre-caches precache[] at install
│   │   ├── runtime.js              get/put/delete helpers for offline + runtime caches
│   │   ├── evict.js                evictByRoute() — route-aware eviction (Option A)
│   │   └── index.js                Barrel re-export
│   ├── fetch/
│   │   ├── strategies.js           5 strategy functions
│   │   ├── router.js               resolveStrategy(request) — glob route matching
│   │   └── index.js                handleFetch(event) — SW fetch event handler
│   └── update/
│       ├── manifest.js             fetchServerManifest / loadCachedManifest / saveCachedManifest
│       ├── diff.js                 computeDiff(newFiles, oldFiles) → { added, modified, removed }
│       ├── apply.js                applyDiff(diff, newManifest) — updates caches
│       └── index.js                checkForUpdate() with lock, startUpdatePolling()
│
└── client/                         ← Runs in main browser thread
    ├── register.js                 register(swUrl, options) — SW registration
    ├── messaging.js                sendToSW(), onSWMessage(), requestUpdateCheck()
    └── update-ui.js                onUpdateReady() → callback + CustomEvent, applyUpdate()
```

---

## Cache Storage Layout

```
CacheStorage
├── offline                         App shell (precached files)
│   └── /_nlpwa/manifest.json       Internal: last-applied manifest snapshot
└── runtime                         Lazily cached responses (filled by fetch strategies)
```

### Why store the manifest inside `offline`?

The manifest snapshot at `/_nlpwa/manifest.json` is a `Response` object stored in the `offline` cache using `cache.put()`. This approach:

- Requires no IndexedDB or localStorage
- Survives SW restarts (persisted in CacheStorage)
- Is excluded from route-aware eviction (path is checked before eviction runs)
- Is never served to the browser (only read internally by the update system)

---

## Data Flow

### 1. SW Install

```
install event
  └─ precacheFiles()
       └─ caches.open('offline')
            └─ cache.add(url) for each url in config.precache
                 (allSettled — soft failures, not fatal)
  └─ self.skipWaiting()
```

### 2. SW Activate

```
activate event
  └─ self.clients.claim()
  └─ startUpdatePolling()     ← sets interval timer
  └─ checkForUpdate()         ← immediate check on first activate
```

### 3. Fetch Interception

```
fetch event (GET, http/https only)
  └─ resolveStrategy(request)
       └─ iterate config.routes top-to-bottom
            └─ matchGlob(route.match, request.url)
                 └─ first match → return strategy function
                 └─ no match   → return defaultStrategy function
  └─ event.respondWith(strategyFn(request))
```

### 4. Update Check

```
checkForUpdate()
  │
  ├─ [guard] _updateInProgress lock — prevents concurrent runs
  │
  ├─ fetchServerManifest()
  │    └─ GET /api/manifest/latest  { cache: 'no-store' }
  │
  ├─ isNewer(server.version, config.version)  →  false? return early
  │
  ├─ loadCachedManifest()
  │    └─ offline['/_nlpwa/manifest.json']  →  previous { version, files }
  │    └─ null on fresh install
  │
  ├─ computeDiff(server.files, cached.files)
  │    └─ Map-based O(n) comparison → { added[], modified[], removed[] }
  │
  ├─ applyDiff(diff, serverManifest)
  │    ├─ fetch added + modified → putInOffline()  (skip on failure)
  │    ├─ deleteFromOffline() for removed
  │    ├─ evictFromRuntime() for modified + removed
  │    ├─ evict runtime entries not in new manifest
  │    ├─ evictByRoute() on both caches
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
| Cache layout | `offline` + `runtime` only | No versioned cache proliferation |
| Manifest storage | Cache entry at `/_nlpwa/manifest.json` | No IndexedDB; survives SW restarts |
| Diff computation | Client-side (SW) | Server stays stateless; one endpoint |
| Eviction rule | Route-strategy-aware | Routes define cacheability; not file presence |
| Update failure | Skip & log (no rollback) | Self-healing on next check; simpler code |
| SW format | ES module (`type: 'module'`) | Modern browsers support it; readable output |
| Client format | IIFE (`NLPWAClient`) | Drop-in `<script>` tag; no bundler required |
