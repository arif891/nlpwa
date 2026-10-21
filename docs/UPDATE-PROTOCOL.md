# NLPWA — Update Protocol

This document specifies the server-side update endpoints and the client-side delta update algorithm.

---

## Two-Tier Update API Endpoints

NLPWA uses a **two-tier** update protocol to minimize network overhead on mobile devices:

### Tier 1: Lightweight Version Check

```
GET /api/update/version.json
```

Returned periodically or on tab focus to determine if an update is available.

**Response:** `200 OK`, `application/json` (~20 bytes)
```json
{
  "version": "1.0.1"
}
```

If the returned `version` equals the currently cached app version (`server.version === cached.version`, with no SW engine version change or pending retry), the update check **stops immediately** without downloading any file lists. Strict equality comparison is used rather than directional semver ordering so that hash-based versions (e.g. `1.0.0-<hash>`, where content hashes have no natural ordering) work seamlessly and server-side rollbacks are immediately recognized and staged.

---

### Tier 2: Full Manifest & Hashes

```
GET /api/update/info.json
```

Fetched **only** if Tier 1 reports a different version (or the SW engine version changed). Contains the complete list of tracked offline files with their SHA-256 hashes.

*(Note: Custom endpoints without `.json` extension, such as `/api/update/version` and `/api/update/info`, are also fully supported).*

**Response:** `200 OK`, `application/json`
```json
{
  "version": "1.0.1",
  "sequence": 1774180000000,
  "minVersion": "1.0.0",
  "blockedVersions": ["0.9.8"],
  "channel": "stable",
  "rolloutPercent": 100,
  "files": [
    { "path": "/api/update/config.json", "hash": "15142550a1b2c3d4e5f6789012345678", "size": 1204 },
    { "path": "/index.html",             "hash": "d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2", "size": 3450 },
    { "path": "/app.js",                 "hash": "a1b2c3d4e5f6789012345678abcdef01", "size": 89400 },
    { "path": "/styles/main.css",        "hash": "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "size": 14200 }
  ],
  "signature": "MCowBQYDK2VwAyEA..."
}
```

| Field               | Type      | Required | Description                                                                                                       |
| ------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `version`           | `string`  | ✅        | Semantic version with content digest (derived deterministically from manifest hash, e.g. `1.0.0-a1b2c3d4e5f6`)    |
| `sequence`          | `number`  | ❌        | Monotonic sequence timestamp/counter. When signing is configured, protects against rollback/replay attacks.       |
| `minVersion`        | `string`  | ❌        | Minimum supported app version (e.g. `2.0.0`). Active or pinned tabs below this version receive `UPDATE_REQUIRED`. |
| `blockedVersions`   | `array`   | ❌        | List of version strings blocked via remote killswitch. Active tabs unpin; client triggers safe fallback.         |
| `channel`           | `string`  | ❌        | Target release channel (`stable`, `beta`, `canary`). Matched against client channel subscription.                 |
| `rolloutPercent`    | `number`  | ❌        | Phased rollout threshold (0–100) evaluated deterministically against device stable random cohort UUID.            |
| `files`             | `array`   | ✅        | List of tracked offline files and their hashes                                                                    |
| `files[].path`      | `string`  | ✅        | URL pathname starting with `/`                                                                                    |
| `files[].hash`      | `string`  | ✅        | Stable content hash (32-character prefix or full 64-character SHA-256 hex string; minimum 32 characters required) |
| `files[].size`      | `number`  | ❌        | Pre-calculated file size in bytes for bandwidth budgeting.                                                       |
| `files[].skipVerify`| `boolean` | ❌        | If true, bypasses hash verification during staging (cryptographically bound in Ed25519 signature payload).         |
| `signature`         | `string`  | ❌        | Base64 Ed25519 detached signature verified by Web Crypto API against configured `publicKey`.                      |

> [!IMPORTANT]
> **Enforcing `minVersion` for Breaking Backend Changes:**
> Client version pinning ensures that open tabs never experience mid-session asset corruption. However, in long-lived sessions (tabs left open for days on mobile devices), a tab pinned to `v1` may eventually call backend APIs that have evolved to `v3`.
>
> By specifying `"minVersion": "2.0.0"` in either `version.json` (Tier 1) or `info.json` (Tier 2):
> 1. The Service Worker immediately drops version pins for any client pinned to a version below `minVersion`.
> 2. The Service Worker broadcasts `UPDATE_REQUIRED` to all connected client windows.
> 3. The client SDK (`NLPWAClient.register()`) triggers `onUpdateRequired` (or automatically reloads the page by default) so users are cleanly migrated to the supported version.

---

## What Files Are Tracked

The build tool tracks **only offline cached files and the config file**:

✅ **Tracked in Manifest:**
- `/api/update/config.json` (runtime configuration file)
- All files declared in `config.precache` (the app shell)

❌ **Not Tracked in Manifest:**
- Runtime-cached assets (fonts, images, lazy routes) — these are cached dynamically when requested according to route fetch strategies.
- API endpoints & backend responses.

---

## Generating the Manifest (Build Pipeline)

### Node.js example

```js
import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

function walkDir(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return walkDir(fullPath, base);
    const urlPath = '/' + relative(base, fullPath).replace(/\\/g, '/');
    return [{ path: urlPath, hash: hashFile(fullPath) }];
  });
}

const manifest = {
  version: process.env.APP_VERSION || '1.0.0',
  files: walkDir('./dist'),
};

console.log(JSON.stringify(manifest, null, 2));
```

### Vite plugin (conceptual)

```js
// vite-plugin-nlpwa-manifest.js
export default function nlpwaManifest() {
  return {
    name: 'nlpwa-manifest',
    generateBundle(options, bundle) {
      const files = Object.keys(bundle).map(fileName => ({
        path: '/' + fileName,
        hash: bundle[fileName].code
          ? require('crypto')
              .createHash('sha256')
              .update(bundle[fileName].code)
              .digest('hex')
              .slice(0, 32)
          : 'static',
      }));

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify({ version: process.env.npm_package_version, files }, null, 2),
      });
    },
  };
}
```

---

## Client-Side Update Algorithm

### Step 1 — Tier 1 Version check

```
GET /api/update/version.json  →  { version: "1.0.0-b6a21cb0" }

serverVersion === activeVersion
  → true:  no update, broadcast NO_UPDATE, stop
  → false: continue to Tier 2 (different version or rollback detected)
```

### Step 2 — Tier 2 Full Manifest

```
GET /api/update/info.json  →  { version: "1.4.2", files: [...] }
```

### Step 3 — Hash diff against active snapshot

```
cachedSnapshot = activeOffline['/_nlpwa/snapshot.json']

computeDiff(newFiles, cachedSnapshot.files):
  for each file in newFiles:
    if not in cachedSnapshot:     → added
    if hash differs:              → modified
    if hash same:                 → unchanged (no network needed)

  for each file in cachedSnapshot:
    if not in newFiles:           → removed
```

### Step 4 — Staging in a separate cache (`stageUpdate`)

```
Open separate cache: offline@1.4.2-<unique-id>

1. Resumption: If file was already downloaded and hash verified in an
   earlier partial staging attempt → reuse without re-downloading.
2. Unchanged files: Copy locally from the active offline cache (0 bytes transferred).
3. Large files (>25MB): Automatically delegated to Background Fetch and streamed
   into IndexedDB ('nlpwa-large-assets') to prevent CacheStorage memory exhaustion.
4. Added & modified files: Fetch fresh from network with { cache: 'no-store' }.
5. Hash Verification:
   - Compute SHA-256 of downloaded body.
   - Match against manifest hash (config.verifyHashes: 'warn' | 'strict' | false; default: 'warn').
   - 'warn' (default): Logs mismatch warning but applies update; resilient to CDN compression.
   - 'strict': Rejects mismatches and HTTP 200 HTML error pages.
   - *Security Scope*: Same-origin hashes protect against network transport corruption, captive portal intercepts, and partial deployments—not against a compromised web origin.
6. Error recovery & Atomicity:
   - If any file fails to fetch or verify, the update is never finalized or committed.
   - Verified files are kept in the staging cache so subsequent checks resume.
   - After 5 consecutive failed attempts, update checks enter exponential backoff
     while the running app remains 100% clean and untouched.
   - **Persistent failure detection**: If retries repeatedly fail on the exact same file(s), NLPWA flags `persistent: true`.
   - **Failure Broadcast**: A `postMessage({ type: 'UPDATE_FAILED', version, failed, error, persistent, hasHashMismatch, retryCount, nextRetryAt })` is broadcast to connected tabs.
7. Seal staging:
   - Once 100% of manifest files are verified, write snapshot to offline@1.4.2-<unique-id>/_nlpwa/snapshot.json
   - Write pointer in IndexedDB (nlpwa-meta): /_nlpwa/staged.json { complete: true, ... }
```

### Step 5 — Notify clients

```
// On staging success:
clients.matchAll({ type: 'window' })
  → postMessage({ type: 'UPDATE_READY', version: '1.4.2' })

// On staging failure or hash mismatch:
clients.matchAll({ type: 'window' })
  → postMessage({ type: 'UPDATE_FAILED', version: '1.4.2', failed: [...], hasHashMismatch: true, ... })
```
The client triggers `nlpwa:update-ready` or `nlpwa:update-failed` CustomEvents on `document` and invokes the corresponding `onUpdateReady` or `onUpdateFailed` callbacks.

### Step 6 — Atomic Commit & Probation (`commitStaged`)

Commit happens smoothly without breaking running pages:
- **On next navigation request** (`request.mode === 'navigate'`, default `applyMode: 'navigation'`), or
- **When user clicks refresh** via `NLPWAClient.applyUpdate()`.

```
commitStaged():
  1. Atomic switch: write /_nlpwa/active.json pointer in IndexedDB (nlpwa-meta).
  2. Initialize probation in IndexedDB: /_nlpwa/probation.json { status: 'probation', healthyBoots: 0, consecutiveFailures: 0 }.
  3. Retain previous active version as nlpwa-fallback cache during probation.
  4. Clear /_nlpwa/staged.json in IndexedDB.
  5. Reload /api/update/config.json into in-memory SW router.
  6. Evict modified & removed entries from runtime cache.
  7. Route-aware eviction on runtime cache.
```

### Step 7 — Multi-Boot Probation & First-Party Error Filtering

Once committed, the new version is protected against catastrophic deployment crashes:
- The previous known-good version remains saved in `nlpwa-fallback`.
- Client boot watchdog monitors initial page boots and calls `nlpwa.markHealthy()`.
- **First-Party Filter:** Errors originating from browser extensions (`chrome-extension://`, `moz-extension://`) or cross-origin scripts (GTM, ads, trackers) are ignored.
- **2-Strike Threshold:** If 2 consecutive first-party boot crashes occur, the Service Worker automatically rolls back to `nlpwa-fallback`, blocks the broken version locally for 24 hours, and notifies clients via `ROLLBACK_APPLIED`.
- **Graduation:** After 2 healthy boots, the new version graduates from probation to stable, and the old fallback cache is swept cleanly.

### Step 8 — Invariant: Built-In Active Cache Rule

To guarantee strict update atomicity while an update is staged in the background, the Service Worker router enforces a **built-in, non-overridable rule** evaluated before user `routes`:
- All precached and manifest files are **always served cache-first from the active offline cache**.
- Even if developer routes include broad catch-alls (e.g. `defaultStrategy: 'network-first'` or dynamic page routes), online requests for app shell files never bypass the staged cache.
- Running tabs continue to serve the coherent active version without receiving partial or mismatched files from the network until `commitStaged()` commits the new version on the next navigation or when the user clicks "Update".

---

## Multi-Version Jumps

Because the server always returns the **complete current file list**, jumping
multiple versions is handled automatically:

```
Client: v1.0.0  →  Server: v1.4.2
```

The SW loads its cached snapshot (which reflects v1.0.0's files), computes the
diff against v1.4.2's files, and builds **one clean staged cache** covering all
intermediate changes. No intermediate manifests are needed.

---

## Self-Healing & Resumption

Failures during staging never corrupt the running application:

| Failure                            | Outcome                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `fetch()` fails or hash mismatches | Active version continues serving untouched; retry on next check                      |
| Network drops mid-update           | Verified files remain cached in staging; resumed on next check                       |
| Single file permanently broken     | Retried with exponential backoff after 5 attempts; active app remains 100% untouched |
| Manifest endpoint unreachable      | Update skipped entirely; retried on next check                                       |

---

## postMessage Protocol

### SW → Client

| Type               | Payload                                                                          | Meaning                                                      |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `UPDATE_READY`     | `{ type, version }`                                                              | Staged update is complete; client should prompt user         |
| `UPDATE_REQUIRED`  | `{ type, minVersion, activeVersion, targetVersion, unpinnedClients }`             | Current version is below minimum supported; force update     |
| `UPDATE_APPLIED`   | `{ type, version, applied }`                                                     | Staged update has been switched to active; client may reload |
| `NO_UPDATE`        | `{ type, version }`                                                              | Version check ran; client is already up to date              |
| `STAGING_PROGRESS` | `{ type, loaded, total, percent, file }`                                         | Staging download and verification progress                   |
| `UPDATE_FAILED`    | `{ type, version, failed, error, persistent, hasHashMismatch }`                  | Staging or hash verification failed                          |
| `VERSION_INFO`     | `{ type, version, activeVersion, stagedVersion, minVersion, updateRequired }`    | Reply with current active, staged, & minVersion info         |
| `STATUS_INFO`      | `{ type, status, activeVersion, stagedVersion, percent }`                        | Reply with current update lifecycle status                   |
| `CACHE_INFO`       | `{ type, data: { quota, usage, runtimeEntries, runtimeBytes, largestEntries } }` | Reply with storage quota & cache metrics                     |
| `RUNTIME_CLEANED`  | `{ type, data: { evictedCount, evictedUrls, freedBytes, remainingEntries } }`    | Reply with cache cleanup summary                             |

### Client → SW

| Type              | Payload             | Meaning                                            |
| ----------------- | ------------------- | -------------------------------------------------- |
| `CHECK_UPDATE`    | `{ type }`          | Client requests an immediate update check          |
| `APPLY_UPDATE`    | `{ type }`          | Client asks SW to commit staged update immediately |
| `GET_VERSION`     | `{ type }`          | Client requests current SW and app version info    |
| `GET_STATUS`      | `{ type }`          | Client requests current update staging status      |
| `GET_CACHE_INFO`  | `{ type }`          | Client requests storage quota & cache stats        |
| `CLEANUP_RUNTIME` | `{ type, options }` | Client requests runtime cache eviction             |

### Client usage

```js
import { register, applyUpdate, onStagingProgress, getVersion, getStatus } from 'nlpwa/client';

register('/sw.js', {
  onUpdateReady: ({ version }) => {
    console.log('Update ready:', version);
    showUpdateBanner();
  },
  onUpdateFailed: ({ version, failed, error, persistent, hasHashMismatch }) => {
    console.warn('Update failed:', error, failed);
    if (persistent && hasHashMismatch) {
      console.warn('Persistent hash mismatch detected - check if CDN or host alters assets');
    }
  },
});

// Subscribe to delta staging progress bar
onStagingProgress(({ loaded, total, percent, file }) => {
  console.log(`Downloading update: ${percent}% (${loaded}/${total} - ${file})`);
  updateProgressBar(percent);
});

// Query live versions and SW status
const versionInfo = await getVersion();
console.log('Active:', versionInfo.activeVersion, 'Staged:', versionInfo.stagedVersion);

const statusInfo = await getStatus();
console.log('Update status:', statusInfo.status); // 'idle' | 'checking' | 'staging' | 'ready' | 'applying'

// When user confirms update
async function onUserClickUpdate() {
  await applyUpdate(); // Sends APPLY_UPDATE, waits for confirmation, reloads
}
```

---

## Update Triggers

Updates are checked through complementary triggers:

| Trigger                  | Who     | Frequency                                                             |
| ------------------------ | ------- | --------------------------------------------------------------------- |
| Client Registration      | Client  | Automatically on registration via non-blocking `CHECK_UPDATE` message |
| Active Tab Interval      | Client  | Every `options.pollIntervalMs` (default: 1 hr) while tab is open      |
| Tab focus / visibility   | Client  | Throttled by `options.focusThrottleMs` (default: 1 hr)                |
| Periodic Background Sync | Browser | Periodically (12-24 hrs) when supported by browser for installed PWAs |
| Manual                   | Client  | Via `requestUpdateCheck()` / `postMessage({ type: 'CHECK_UPDATE' })`  |

A concurrency lock prevents two update runs from overlapping regardless of
which trigger fires.

---

## Integrity Models: Works Out of the Box vs. Optional Security

NLPWA distinguishes clearly between **Works Out of the Box** (frictionless, resilient defaults) and **Optional Progressive Security** (opt-in architectural layer):

### 1. Works Out of the Box (Operational Integrity by Default)
- **Mechanism:** During update staging, downloaded assets are verified against SHA-256 hashes published in `info.json` using `verifyHashes: 'warn'`.
- **Zero Friction:** `signingKey: false` by default. Developers do not need to generate Ed25519 keypairs or configure cryptographic parameters to deploy a high-performance offline PWA.
- **Resilient to Edge Rewrites:** CDNs that dynamically compress, minify HTML, or inject scripts in transit will log warnings rather than failing the update staging pipeline.
- **What it catches:**
  - **Network truncation:** Incomplete downloads over spotty Wi-Fi / cellular connections are caught and retried.
  - **Soft-404 / SPA fallbacks:** CDNs or static hosts returning `200 OK` with HTML `index.html` for missing chunks are blocked before overwriting JavaScript bundles.
  - **Captive portals:** Wi-Fi login walls intercepting bundle requests are detected before corrupting the cache.
  - **Partial multi-CDN deployments:** Updates are only staged if all files match their expected structure.
- **Scope:** Protects against network glitches, CDN cache inconsistency, and transport corruption without breaking production deployments.

### 2. Optional Progressive Security (Cryptographic Tamper-Evidence via Ed25519)
- **The Core Insight:** The Service Worker engine script itself (`sw.js`) is byte-checked directly by the browser (bypassing HTTP caches every 24 hours or on navigation). Because `sw.js` is an authenticated trust anchor, you can embed an **Ed25519 Public Key** into `sw.js` via `nlpwa.config.js`.
- **Workflow:**
  1. Generate keypair using `npx nlpwa keys:generate`.
  2. Build / CI pipeline signs `info.json` using `signingKey` (e.g. from environment variable `NLPWA_SIGNING_KEY`).
  3. The CLI computes a detached cryptographic signature of `info.json` and embeds it as `"signature": "<base64>"` (or writes `info.json.sig`).
  4. When the Service Worker fetches `info.json`, it verifies the signature using the browser's built-in Web Crypto API:
     ```js
     const verified = await crypto.subtle.verify(
       { name: 'Ed25519' },
       embeddedPublicKey,
       signatureBytes,
       manifestBytes
     );
     ```
  5. If verification fails, the staging update is completely aborted before downloading a single asset.
- **Strict Hash Verification:** Pair with `verifyHashes: 'strict'` to enforce zero byte divergence from the build manifest.
- **Advantage over Workbox / Subresource Integrity (SRI):**
  - Standard SRI requires annotating every single `<script integrity="...">` tag in the HTML entry point.
  - Ed25519 manifest signing gives end-to-end cryptographic tamper-evidence against compromised CDNs, compromised reverse proxies, or man-in-the-middle attacks, with zero HTML plumbing and zero performance overhead.

