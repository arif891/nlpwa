# Configuration Reference — Global Options Schema

Comprehensive reference for all top-level settings in `nlpwa.config.js`.

---

## Identity & Endpoints

### `version` · `string` · default: `'auto'`
The deployed version of your web application.
- **Deterministic Hash Derivation (Default):** When you run `nlpwa update` or the Rollup/Vite plugin, NLPWA computes a composite SHA-256 hash of all tracked files and configuration rules.
  - If `version: '1.0.0'` is set in `config.js`, the emitted version is formatted as `1.0.0-<hash>`.
  - If `version: 'auto'` or omitted, the version is the pure content hash (e.g. `a1b2c3d4e5f6`).
- **Idempotent & CI-Safe:** Rebuilding identical code produces the exact same hash, preventing spurious updates.
- **Rollback-Safe:** Reverting a Git commit regenerates that release's exact hash, allowing clients to roll back cleanly.

### `updateAPI` · `object`
Defines the two-tier update check endpoints:
- `version`: Lightweight endpoint returning `{ "version": "1.0.1" }` (~20 bytes). Polled periodically or on focus.
- `info`: Full manifest endpoint returning `{ "version": "1.0.1", "files": [ ... ] }`. Only downloaded when a newer version exists.

```javascript
updateAPI: {
  version: '/api/update/version.json',
  info:    '/api/update/info.json',
  timeoutMs: 15000,
}
```

### `configPath` · `string` · default: `'/api/update/config.json'`
The URL pathname where `api/update/config.json` is served and cached in the `offline` store.

### `base` · `string` · default: `''`
Base public path where the application is hosted (e.g. `'/my-app/'` for subpath deployments or GitHub Pages).

---

## Development & Debugging

### `dev` · `boolean` · default: `false`
Toggles Development / UI Design Mode.
- When `true`, NLPWA bypasses Service Worker registration, cleanly unregisters any active workers under the scope, and flushes active CacheStorage stores.
- Enables friction-free UI design, CSS tweaking, and bundler Hot Module Replacement (HMR) without stale cache interference.
- Can also be toggled at runtime via `<script data-dev="true">`, `window.NLPWA_DEV = true`, or `register('/sw.js', { dev: true })`.
- When set back to `false`, the Client SDK automatically restores normal Service Worker registration without manual browser cache clearing.

---

## Caching & Storage Names

### `caches` · `object`
Override the default CacheStorage names:
```javascript
caches: {
  offline: 'my-app-offline',   // default: 'offline'
  runtime: 'my-app-runtime',   // default: 'runtime'
  meta:    'my-app-meta',      // default: 'nlpwa-meta'
}
```

### `clearRuntimeOnUpdate` · `boolean` · default: `false`
When `true`, completely wipes the `runtime` cache upon committing a new version. Recommended if your application caches unfingerprinted static assets.

### `retainPreviousVersionCache` · `boolean` · default: `true`
When `true`, retains the immediate prior version's cache (`v(N-1)`) as a fallback during probation or for lazy-loaded chunks.

### `cacheOpaque` · `boolean` · default: `false`
When `false`, ignores opaque cross-origin responses (`status: 0`), preventing Chromium browsers from inflating storage quotas by ~7 MB per opaque response.

---

## Update Staging & Verification

### `verifyHashes` · `'strict' | 'warn' | false` · default: `'warn'`
How downloaded update files are verified against manifest hashes:
- `'warn'` (default): Logs warnings on mismatches but continues staging. Ensures resilience against CDN minification or edge compression.
- `'strict'`: Strictly aborts staging if a single byte differs from the manifest.

### `maxVerifyBytes` · `number` · default: `26214400` (25 MB)
Maximum file size in bytes to buffer and verify with in-memory SHA-256 hashing. Prevents mobile out-of-memory crashes on oversized assets.

### `largeFileThresholdBytes` · `number` · default: `26214400` (25 MB)
Threshold above which large update assets automatically delegate to Background Fetch and stream directly into native `CacheStorage` on disk.

### `applyMode` · `'navigation' | 'immediate'` · default: `'navigation'`
- `'navigation'` (default): Updates stage completely in the background and commit on the next document navigation without interrupting active users.
- `'immediate'`: Applies update immediately upon staging completion.

---

## Multi-Boot Probation & Safety

### `probation` · `object | boolean` · default: `{ requiredHealthyBoots: 2, failureThreshold: 2, clientBlockTtlMs: 86400000 }`
Multi-boot probation settings for newly activated releases:
- `requiredHealthyBoots` (`number`, default: `2`): Number of successful boots (`nlpwa.markHealthy()`) needed to graduate to stable.
- `failureThreshold` (`number`, default: `2`): Consecutive startup crashes before triggering an automatic rollback to `nlpwa-fallback`.
- `clientBlockTtlMs` (`number`, default: `86400000`): How long (in ms) a rolled-back version is blocked on that client (default: 24 hrs).

### `watchdog` · `object`
Controls the automatic boot watchdog timer:
```javascript
watchdog: {
  enabled: true,
  timeoutMs: 10000, // Disarmed when nlpwa.markHealthy() is called
}
```

---

## Advanced Release & Security Controls

### `publicKey` · `string` · default: `null`
Ed25519 public key. When set, update manifests must include a valid detached cryptographic signature verified via Web Crypto before staging begins.

### `rolloutPercent` · `number` (0–100) · default: `100`
Canary rollout percentage. Assigns clients deterministic percentiles to stage updates incrementally.

### `channel` · `'stable' | 'beta'` · default: `'stable'`
Isolates pre-release channels from stable production clients.

### `blockedVersions` · `string[]` · default: `[]`
Remote kill-switch list of revoked versions. Any client on a blocked version is immediately unpinned and prompted to upgrade.

### `stagingBudget` · `object`
Bandwidth & data constraints:
```javascript
stagingBudget: {
  respectSaveData: true,               // Abort staging if saveData is enabled
  maxUpdateBytes: 50 * 1024 * 1024,   // Max cumulative update download cap
  wifiOnlyThresholdBytes: 10 * 1024 * 1024, // Require Wi-Fi for updates >10 MB
}
```

### `telemetry` · `boolean | { url?: string }` · default: `false`
Opt-in error and rollback telemetry reporting.
