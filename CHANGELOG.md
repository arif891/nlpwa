# Changelog

All notable changes to `nlpwa` will be documented in this file.

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
- **Removed Legacy Unversioned Cache Migration**: Removed legacy `name === base` unversioned offline cache deletion logic from `store.js`. Staged and active caches strictly follow the versioned pointer architecture (`offline@<version>-<id>`).
- **Retained & Documented `precacheWithoutManifest`**: Maintained `precacheWithoutManifest` as the supported fallback installation path for projects that have not yet executed `nlpwa update`.

#### Package Exports
- **Trimmed Duplicate Exports**: Removed duplicate `"./config"` export in `package.json` in favor of `"./config.json"`.
