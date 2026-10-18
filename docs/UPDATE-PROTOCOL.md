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
  "files": [
    { "path": "/config.json",       "hash": "15142550a1b2c3d4e5f6789012345678" },
    { "path": "/index.html",        "hash": "d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2" },
    { "path": "/app.js",            "hash": "a1b2c3d4e5f6789012345678abcdef01" },
    { "path": "/styles/main.css",   "hash": "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `string` | ✅ | Semantic version with content digest (derived deterministically from manifest hash, e.g. `1.0.0-a1b2c3d4e5f6`) |
| `files` | `array` | ✅ | List of tracked offline files and their hashes |
| `files[].path` | `string` | ✅ | URL pathname starting with `/` |
| `files[].hash` | `string` | ✅ | Stable content hash (32-character prefix or full 64-character SHA-256 hex string; minimum 32 characters required) |

---

## What Files Are Tracked

The build tool tracks **only offline cached files and the config file**:

✅ **Tracked in Manifest:**
- `/config.json` (runtime configuration file)
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
3. Added & modified files: Fetch fresh from network with { cache: 'no-store' }.
4. Hash Verification:
   - Compute SHA-256 of downloaded body.
   - Match against manifest hash (config.verifyHashes: 'strict' | 'warn' | false).
   - Strict mode rejects mismatches (and HTTP 200 HTML error pages).
   - *Security Scope*: Same-origin hashes protect against network transport corruption, captive portal intercepts, and partial deployments—not against a compromised web origin.
   - *Memory Considerations*: `fetchVerified` clones and buffers the response into an `ArrayBuffer` in memory to compute its digest before storing the original in `CacheStorage`. This temporarily doubles memory consumption per fetched file. For this reason, `precache` should be kept strictly limited to small app shell assets; large media (videos, heavy 3D assets/datasets) should be routed through runtime caching strategies instead.
5. Error recovery & Atomicity:
   - If any file fails to fetch or verify, the update is never finalized or committed.
   - Verified files are kept in the staging cache so subsequent checks resume.
   - After 5 consecutive failed attempts, update checks enter exponential backoff
     while the running app remains 100% clean and untouched.
   - **Persistent failure detection**: If retries repeatedly fail on the exact same file(s), NLPWA flags `persistent: true`. If caused by hash mismatches (e.g. CDN script injection or HTML minification), a prominent error is logged recommending `verifyHashes: 'warn'`.
   - **Failure Broadcast**: A `postMessage({ type: 'UPDATE_FAILED', version, failed, error, persistent, hasHashMismatch, retryCount, nextRetryAt })` is broadcast to connected tabs so clients can inspect or react.
6. Seal staging:
   - Once 100% of manifest files are verified, write snapshot to offline@1.4.2-<unique-id>/_nlpwa/snapshot.json
   - Write pointer in nlpwa-meta: /_nlpwa/staged.json { complete: true, ... }
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

### Step 6 — Atomic Commit (`commitStaged`)

Commit happens smoothly without breaking running pages:
- **On next navigation request** (`request.mode === 'navigate'`), or
- **When user clicks refresh** via `NLPWAClient.applyUpdate()`.

```
commitStaged():
  1. Atomic switch: write /_nlpwa/active.json pointer in nlpwa-meta.
  2. Clear /_nlpwa/staged.json in nlpwa-meta.
  3. Reload /config.json into in-memory SW router.
  4. Evict modified & removed entries from runtime cache.
  5. Route-aware eviction on runtime cache.
  6. Prune old offline@... caches.
```

### Step 7 — Invariant: Built-In Active Cache Rule

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

| Failure | Outcome |
|---|---|
| `fetch()` fails or hash mismatches | Active version continues serving untouched; retry on next check |
| Network drops mid-update | Verified files remain cached in staging; resumed on next check |
| Single file permanently broken | Retried with exponential backoff after 5 attempts; active app remains 100% untouched |
| Manifest endpoint unreachable | Update skipped entirely; retried on next check |

---

## postMessage Protocol

### SW → Client

| Type | Payload | Meaning |
|---|---|---|
| `UPDATE_READY` | `{ type, version }` | Staged update is complete; client should prompt user |
| `UPDATE_APPLIED` | `{ type, applied }` | Staged update has been switched to active; client may reload |
| `NO_UPDATE` | `{ type, version }` | Version check ran; client is already up to date |
| `UPDATE_FAILED` | `{ type, version, failed, error, persistent, hasHashMismatch }` | Staging or hash verification failed |

### Client → SW

| Type | Payload | Meaning |
|---|---|---|
| `CHECK_UPDATE` | `{ type }` | Client requests an immediate update check |
| `APPLY_UPDATE` | `{ type }` | Client asks SW to commit staged update immediately |

### Client usage

```js
import { register, applyUpdate } from '/client.js';

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

// When user confirms update
async function onUserClickUpdate() {
  await applyUpdate(); // Sends APPLY_UPDATE, waits for confirmation, reloads
}
```

---

## Update Triggers

Updates are checked through complementary triggers:

| Trigger | Who | Frequency |
|---|---|---|
| Client Registration | Client | Automatically on registration via non-blocking `CHECK_UPDATE` message |
| Active Tab Interval | Client | Every `options.pollIntervalMs` (default: 1 hr) while tab is open |
| Tab focus / visibility | Client | Throttled by `options.focusThrottleMs` (default: 1 hr) |
| Periodic Background Sync | Browser | Periodically (12-24 hrs) when supported by browser for installed PWAs |
| Manual | Client | Via `requestUpdateCheck()` / `postMessage({ type: 'CHECK_UPDATE' })` |

A concurrency lock prevents two update runs from overlapping regardless of
which trigger fires.
