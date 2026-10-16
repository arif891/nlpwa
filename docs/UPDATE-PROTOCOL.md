# NLPWA — Update Protocol

This document specifies the server-side update endpoints and the client-side delta update algorithm.

---

## Two-Tier Update API Endpoints

NLPWA uses a **two-tier** update protocol to minimize network overhead on mobile devices:

### Tier 1: Lightweight Version Check

```
GET /api/update/version
```

Returned periodically or on tab focus to determine if an update is available.

**Response:** `200 OK`, `application/json` (~20 bytes)
```json
{
  "version": "1.0.1"
}
```

If the returned `version` is not newer than the currently cached app version, the update check **stops immediately** without downloading any file lists.

---

### Tier 2: Full Manifest & Hashes

```
GET /api/update/info
```

Fetched **only** if Tier 1 reports a strictly newer version. Contains the complete list of tracked offline files with their SHA-256 hashes.

**Response:** `200 OK`, `application/json`
```json
{
  "version": "1.0.1",
  "files": [
    { "path": "/config.json",       "hash": "15142550" },
    { "path": "/index.html",        "hash": "d7e8f9a0" },
    { "path": "/app.js",            "hash": "a1b2c3d4" },
    { "path": "/styles/main.css",   "hash": "e5f6a7b8" }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `string` | ✅ | Semantic version of the deployment (auto-incremented by build tool) |
| `files` | `array` | ✅ | List of tracked offline files and their hashes |
| `files[].path` | `string` | ✅ | URL pathname starting with `/` |
| `files[].hash` | `string` | ✅ | Stable content hash (SHA-256 first 8 hex characters) |

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
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
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
              .slice(0, 8)
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

### Step 1 — Version check

```
GET /api/manifest/latest  →  { version: "1.4.2", files: [...] }

isNewer("1.4.2", config.version)
  → false: no update, broadcast NO_UPDATE, stop
  → true:  continue
```

### Step 2 — Load cached manifest

```
offline['/_nlpwa/manifest.json']
  → found:   { version: "1.3.0", files: [...oldFiles] }
  → not found: treat oldFiles as []  (fresh install, all files are "added")
```

### Step 3 — Hash diff

```
computeDiff(newFiles, oldFiles):

  for each file in newFiles:
    if not in oldFiles:     → added
    if hash differs:        → modified
    if hash same:           → (no action)

  for each file in oldFiles:
    if not in newFiles:     → removed
```

### Step 4 — Apply diff

```
For each path in added + modified:
  fetch(path, { cache: 'no-store' })
    → ok:     putInOffline(path, response)
    → error:  log warning, skip (stale version stays, self-heals next check)

For each path in removed:
  deleteFromOffline(path)

Evict from runtime cache:
  → paths in modified (hash changed → serve fresh)
  → paths in removed  (file gone)
  → paths not in new manifest at all

Route-aware eviction (both caches):
  → any entry whose URL no longer matches a caching-capable route

Save new manifest:
  offline['/_nlpwa/manifest.json'] = newManifest
```

### Step 5 — Notify clients

```
clients.matchAll({ type: 'window' })
  → client.postMessage({ type: 'UPDATE_READY', version: '1.4.2' })
```

---

## Multi-Version Jumps

Because the server always returns the **complete current file list**, jumping
multiple versions is handled automatically:

```
Client: v1.0.0  →  Server: v1.4.2
```

The SW loads its cached manifest (which reflects v1.0.0's files), computes the
diff against v1.4.2's files, and applies **one atomic update** covering all
intermediate changes. No intermediate manifests are needed.

This means you can also skip version numbers freely — version numbers are only
used for the `isNewer()` comparison, not for routing through intermediate states.

---

## Self-Healing

Failures during `applyDiff` are non-fatal:

| Failure | Outcome |
|---|---|
| `fetch()` fails for a modified file | Old cached version stays; retried on next check |
| Manifest endpoint unreachable | Update skipped entirely; retried on next check |
| Partial update applied | Next check re-diffs and fetches any remaining changed files |

The system converges towards the correct state on every check without any
explicit retry logic, rollback, or transactional locking.

---

## postMessage Protocol

### SW → Client

| Type | Payload | Meaning |
|---|---|---|
| `UPDATE_READY` | `{ type, version }` | Update has been applied; client should prompt user |
| `NO_UPDATE` | `{ type, version }` | Version check ran; client is already up to date |

### Client → SW

| Type | Payload | Meaning |
|---|---|---|
| `CHECK_UPDATE` | `{ type }` | Client requests an immediate update check |

### Client usage

```js
// Listen for updates
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data.type === 'UPDATE_READY') {
    console.log('Ready to update to:', event.data.version);
  }
});

// Trigger manual check
navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_UPDATE' });
```

Or use the client library:

```js
document.addEventListener('nlpwa:update-ready', (e) => {
  console.log('New version:', e.detail.version);
  NLPWAClient.applyUpdate();  // or show a banner
});
```

---

## Update Triggers

Updates are checked in four complementary ways:

| Trigger | Who | Frequency |
|---|---|---|
| Activation | SW | Every time the SW activates (app open / reload) |
| Active Tab Interval | Client | Every `options.pollIntervalMs` (default: 1 hr) while tab is open |
| Tab focus / visibility | Client | Throttled by `options.focusThrottleMs` (default: 5 min) |
| Periodic Background Sync | Browser | Periodically when supported by browser for installed PWAs |
| Manual | Client | Via `postMessage({ type: 'CHECK_UPDATE' })` |

A concurrency lock prevents two update runs from overlapping regardless of
which trigger fires.
