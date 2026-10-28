# Changelog

All notable changes to `nlpwa` will be documented in this file.

## [0.2.32] - 2026-10-28

### Refactoring & Simplification
- **Removed Dev Mode Magic**: Completely removed `data-dev`, `window.NLPWA_DEV`, `isDevMode()`, and `enforceDevMode()`. Because Service Workers intercept and serve precached application shells (`/index.html`) cache-first, client-side HTML attributes cannot bypass active Service Workers without developer intervention. Standardized on omitting `client.js` or using `data-auto-register="false"` during development, and unregistering via DevTools or `unregister()`.

## [0.2.31] - 2026-10-28

### Features & Developer Experience
- **Dev Mode Cache Purge Isolation**: Moved CacheStorage purging out of standard `unregister()` into an explicit `purgeCaches: true` option invoked only by `enforceDevMode()`, preventing accidental cache eviction on production unregister calls (such as on user logout).
- **Synchronous `isDevMode()`**: Streamlined `isDevMode()` into a synchronous check with zero network overhead.
- **Manual Registration Dev Support**: Extended manual `register()` invocations to check `<script data-dev>` attributes via `isDevMode(options.script)`.
- **First Dev Reload Stale Prevention**: Added automatic single-reload in `enforceDevMode()` when an active Service Worker controller is detected, guarded by `sessionStorage` with safe fallback when storage throws (sandboxed iframes, blocked storage).
- **Accidental Production Dev Mode Warning**: Added warning when dev mode is active on non-localhost/non-127.0.0.1 hostnames.
- **Cleaned Router Leftovers**: Removed dead `requestUrl.searchParams.has('nlpwa_dev')` checks and updated internal comments.

## [0.2.3] - 2026-10-28

### Features & Developer Experience
- **Development & UI Design Mode**:
  - Added first-class Development Mode activated locally via `<script data-dev>`, `<script data-dev="true">`, or `window.NLPWA_DEV = true`.
  - When enabled, the Client SDK bypasses registration, unregisters existing Service Workers under the scope, and flushes CacheStorage stores so styles, HTML, and assets update live with zero caching interference.
  - Added `isDevMode()`, `isDevFlag()`, and `enforceDevMode()` client SDK exports with zero production network overhead.
  - Implemented automatic recovery: toggling Dev Mode off cleanly re-registers the Service Worker on next load without manual cache or worker eviction.
- **Framework-Agnostic SW Core**:
  - Removed all hardcoded bundler-specific paths (`/@vite/`, `/@fs/`, `.hot-update.json`) from `src/sw/fetch/router.js`, ensuring pure framework neutrality across Vite, Webpack, Turbopack, and vanilla setups.

### Serverless & Edge Deployments
- **Zero-Collision Manifest Routing**:
  - Added `api/update/manifest.js` and `vercel.json` rewrites to eliminate static file shadowing under reserved `/api/*` routes on Vercel and similar serverless platforms.
- **Multi-Container Simulated Version Synchronization**:
  - Implemented cookie-based version synchronization (`nlpwa_version` cookie) in `/api/update/bump` and `/api/update/reset` for simulated OTA update testing across isolated serverless lambda containers.
- **Controlled Deployment Pipelines**:
  - Added `"git": { "deploymentEnabled": false }` configuration support in `vercel.json` to prevent automatic build triggers on Git push and support manual Vercel Deploy Hooks (`curl -X POST <hook-url>`) and CLI deployments (`vercel --prod`).

### Bug Fixes & Showcase UI Improvements
- **Deferred Tab Activation on Initial Load**: Fixed temporal dead zone (TDZ) `ReferenceError: Cannot access 'manifestViewport' before initialization` on direct hash navigation (e.g. `/#updates`) in `example/app.js`.
- **Manifest Dev Probe Accuracy**: Fixed issue in `/api/update/manifest.js` where `?nlpwa_dev=1` probe query mistakenly forced `data.dev = true`.
- **Fluid CSS Property Transitions**: Added CSS `@property` registered custom properties (`--status-mid`, `--status-end`, `--bar`) for smooth color gradients and gauge glow transitions.
- **In-Place Strategy Bar Animation**: Refactored `renderBars()` in `example/app.js` to update existing DOM elements in place rather than replacing children, enabling continuous height and background color CSS transitions.

## [0.2.2] - 2026-10-23

### Security Hardening & Update Pipeline Resilience
- **Minimum Node Version**: Updated engine requirement to Node `>=22`.
- **Tier 1 Monotonic Sequence Verification**: Enforced monotonic sequence check on Tier 1 responses in cryptographic mode (`config.publicKey`); rejected replayed or missing sequence payloads and discarded untrusted metadata so compromised CDNs cannot freeze updates or unblock versions.
- **Strictly Monotonic `minVersion`**: Guarded `setMinVersion` with `compare(minVersion, current) > 0` so replayed payloads cannot lower the minimum supported version.
- **Lock Queuing for Emergency Rollbacks**: Extended `withLock` with `{ wait: true }` and updated `rollbackToFallback` to queue on Web Locks / poll in-memory locks instead of failing immediately.
- **Rotating Phased Rollout Cohorts**: Replaced static sticky seed with `stringHash(`${seed}:${targetVersion}`) % 100`, fairly distributing canary exposure across releases while maintaining determinism per client version.
- **Rollback Pin Protection**: Prevented `rollbackToFallback` from deleting failing caches while active client tabs are still pinned to them, preserving the "zero version drift" guarantee.
- **Interrupted Install Null-Safety**: Added `active?.version` safety checks and generic context logging in `discardStaged`, eliminating `TypeError: Cannot read properties of null` during fresh install recovery.

## [0.2.1] - 2026-10-20

### Bug Fixes

#### Configuration Migration to Approach 1
- **Scoped Runtime Manifest**: Moved emitted runtime configuration from the root `/config.json` to `/api/update/config.json`, preventing collisions with existing application configuration files.
- **Root Source Configuration**: `nlpwa init` now scaffolds `nlpwa.config.js` at the repository root and the CLI update and bundler plugins prioritize `nlpwa.config.js` over legacy paths.
- **Precache Fallback Resolution**: Updated Service Worker installation, commit, and cache store to look up and cache `/api/update/config.json` by default.
- **Extracted `enforceMinVersion` Helper**: Extracted duplicated minimum supported version enforcement between Tier 1 (`/api/update/version`) and Tier 2 (`/api/update/info`) checks in `src/sw/update/index.js`, eliminating duplicate broadcast guards and ensuring unified client unpinning and notification.
- **Improved Failure Observability**: Replaced silent error swallowing in `src/sw/update/commit.js` and `src/sw/update/index.js` (staged config parsing, client post-commit messaging, rolled-back staged cache deletion) with debug-level logging via `logger.debug`.

## [Unreleased] - 2026-10-19

### Modular Architecture Restructuring & File Decomposition
- **Fetch Strategies Decomposition**: Deconstructed monolithic `src/sw/fetch/strategies.js` (657 lines) into dedicated strategy submodules under `src/sw/fetch/strategies/` (`cache-first.js`, `network-first.js`, `network-only.js`, `stale-while-revalidate.js`, `cache-only.js`, and `context.js`).
- **Cache Subsystem Partitioning**: Partitioned `src/sw/cache/` into dedicated functional domains:
  - `meta/`: Low-level JSON metadata, active/staged pointers, client version pins, and Web Locks concurrency (`store.js`, `active.js`, `staged.js`, `client-pins.js`, `lock.js`).
  - `offline/`: App shell cache, directory index resolution, clean URLs, and subpath base alias matching (`store.js`, `aliases.js`, `install.js`).
  - `runtime/`: Dynamic route cache read/write and tracking parameter cleanup (`store.js`, `keys.js`).
  - `eviction/`: Quota detection, byte size resolution, and multi-policy eviction (`quota.js`, `size.js`, `policies.js`, `route-cleaner.js`).
- **SW Event Lifecycle Controllers**: Extracted all Service Worker event listeners from `src/sw/index.js` into dedicated lifecycle modules under `src/sw/events/` (`install.js`, `activate.js`, `message.js`, `push.js`, `sync.js`), reducing `src/sw/index.js` to a clean 23-line orchestrator.
- **Update Staging Pipeline**: Decomposed `src/sw/update/stage.js` into modular components under `src/sw/update/staging/` (`verifier.js`, `fetcher.js`, `orchestrator.js`).
- **Client Runtime Decomposition**: Refactored `src/client/register.js` into modular client components under `src/client/` (`registration.js`, `form-guard.js`, `polling.js`, `index.js`).
- **Modular CLI Architecture**: Migrated the 555-line CLI implementation from `bin/nlpwa.js` into modular commands under `src/cli/` (`commands/`, `core/`, `ui/`, `index.js`), reducing `bin/nlpwa.js` to a clean executable shim.
- **Shared Utilities**: Added `src/shared/async.js` for bounded concurrency mapping (`mapConcurrent`) and `src/shared/time.js` for duration parsing and TTL expiration checks.

## [0.2.0] - 2026-10-18

### Breaking Changes

#### Configuration & Vocabulary Consolidation
- **Collapsed Snapshot Key**: Renamed `manifestCachePath` to `snapshotCachePath`. The server manifest is now consistently referred to as `info` and the locally cached copy as `snapshot`.
- **Security Lock on Snapshot Path**: `updateActiveConfig()` now strictly locks `snapshotCachePath: _config.snapshotCachePath`. Runtime `config.json` files fetched over the network can no longer set or override `snapshotCachePath`.
- **Simplified `getSnapshotPath()`**: Removed fallback lookup chains; `getSnapshotPath()` now directly returns `getConfig().snapshotCachePath`.
- **Function Renames**:
  - `fetchServerManifest` → `fetchServerInfo`
  - `loadCachedManifest` → `loadCachedSnapshot`
  - `saveCachedManifest` → `saveCachedSnapshot`
- **Constant Removal**: Removed `MANIFEST_CACHE_PATH` alias in `src/shared/constants.js`. Use `SNAPSHOT_CACHE_PATH`.

#### Route & Config Option Synonyms
- **Collapsed Option Synonyms**: Synonyms in fetch strategies and routing configuration have been collapsed to single canonical names:
  - `maxAge` (duration string e.g. `'7d'` or ms number) replaces `maxAgeMs`, `maxAgeSeconds`, and `ttl`.
  - `throwOnFailure` replaces `throwOfflineError`.
  - `cacheOpaque` replaces `opaque`.
- **Strict Option Validation**: `validateConfig` in `schema.js` now validates top-level configuration and per-route options against canonical sets and rejects unrecognized or deprecated keys with actionable errors.

#### Update API Shape
- **Canonical Object Form**: `updateAPI` must now be configured as an object `{ version, info }`. The legacy array format `[{ type, endpoint }]` has been removed.

#### Dead State & Update Protocol Simplification
- **Removed Dead State**: Removed unreachable states `degraded`, `needsRetry`, and `partial` from staging, update orchestration, and client messaging.
- **Simplified `UPDATE_READY` Event**: The `UPDATE_READY` message and client event payload now contains `{ type: 'UPDATE_READY', version }` without the dead `partial` boolean.

#### Content Integrity & Hashing
- **Tighter Prefix Matching**: In `src/shared/hash.js`, `hashMatches()` now requires a minimum of 32 hexadecimal characters (128-bit match), matching the CLI digest output and eliminating short 8-character prefix acceptance.

#### Cache Cleanup
- **Retain Previous Cache on SW Activation**: Fixed `sweepOrphanCaches()` to include `(await getActive())?.previousCache` in its keep list, ensuring `retainPreviousVersionCache` is not dropped on SW engine activation while older tabs remain open.
- **Unversioned Offline Cache Cleanup on Update**: Maintained unversioned base cache cleanup (`name === base`) in `cleanupCaches()`. When an app installed via the no-manifest fallback (`precacheWithoutManifest`) or an older version receives its first update, the unversioned `offline` cache is cleanly removed upon committing the versioned cache, preventing leaked duplicate caches.
- **Retained & Documented `precacheWithoutManifest`**: Maintained `precacheWithoutManifest` as the supported fallback installation path for projects that have not yet executed `nlpwa update`.

#### Messaging & Update Coordination
- **Disambiguated `UPDATE_APPLIED`**: Added `APPLY_UPDATE_RESULT` for 1-to-1 replies via dedicated `MessageChannel` ports in `applyUpdate()`. This prevents polluting the global window message bus with undefined versions, avoids duplicate `nlpwa:update-applied` event dispatches on the initiating tab, and ensures tabs never reload when `applied: false`.
- **Custom Deferral Predicate (`shouldDeferReload`)**: Added `shouldDeferReload({ version, reason })` option to `NLPWAClient.register()`, allowing applications to defer reloads based on custom in-memory dirty state or background uploads in progress in addition to active element focus.

#### Lock Granularity & Manifest Hashing
- **Narrowed Concurrency Lock**: Narrowed `checkForUpdate`'s lock to only wrap actual staging writes and commits. Tier 1 and Tier 2 network roundtrips no longer hold the lock, ensuring that navigations and `commitIfReady()` are never blocked while checks are in flight.
- **Manifest File Sizes**: The CLI and build plugin now explicitly emit file `size` in `info.json` manifests, ensuring threshold checks for `maxVerifyBytes` do not rely on missing or stripped `Content-Length` headers. Documented that files over `maxVerifyBytes` (20 MB default) bypass in-memory SHA-256 hashing even under `verifyHashes: 'warn'` to prevent low-end device OOM crashes.

#### Package Exports
- **Trimmed Duplicate Exports**: Removed duplicate `"./config"` export in `package.json` in favor of `"./config.json"`.

#### Tooling, CI & Documentation
- **Build Drift Resolution**: Updated `npm run build` to build production minified bundles matching tracked `example/` assets, avoiding 3.5k lines of unminified diff on build. Added `npm run build:dev` for unminified debugging.
- **GitHub Actions CI Workflow**: Added `.github/workflows/ci.yml` running on Node 22 (supporting Node >=20) with unit tests, production build drift checks (`check:drift`), and Playwright E2E tests.
- **API & Event Documentation**: Documented `onUpdateFailed` in options table, added `nlpwa:update-failed` and `nlpwa:update-prompt` event examples to `README.md`, removed stale `fifo` mention from `docs/ARCHITECTURE.md`, and added an objective "When Workbox is the Better Choice" section.
