# NLPWA — Update Protocol

This document specifies the server-side manifest format and the client-side
update algorithm. Follow this if you are:

- Building a server to work with NLPWA
- Implementing a manifest generation tool for your build pipeline
- Debugging update behaviour

---

## Manifest Endpoint

```
GET /api/manifest/latest
```

The server exposes **one endpoint** that always returns the **complete current
state** of all files. There is no server-side diff or delta computation — NLPWA
does all comparison on the client.

### Response

**Status:** `200 OK`
**Content-Type:** `application/json`

```json
{
  "version": "1.4.2",
  "files": [
    { "path": "/app.js",            "hash": "a1b2c3d4" },
    { "path": "/styles/main.css",   "hash": "e5f6a7b8" },
    { "path": "/assets/logo.png",   "hash": "c9d0e1f2" },
    { "path": "/pages/about.html",  "hash": "f3a4b5c6" },
    { "path": "/index.html",        "hash": "d7e8f9a0" }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `string` | ✅ | Semantic version of the current deployment |
| `files` | `array` | ✅ | Complete list of all cacheable files |
| `files[].path` | `string` | ✅ | URL pathname starting with `/` |
| `files[].hash` | `string` | ✅ | Stable content identifier for this file |

### `version` format

Use semantic versioning: `MAJOR.MINOR.PATCH`

```
1.0.0  →  1.0.1  →  1.1.0  →  2.0.0
```

NLPWA compares versions numerically. A client on `1.0.0` will update
when the server returns any version where the numeric comparison is greater:
`1.0.1`, `1.1.0`, `2.0.0`, etc.

### `hash` format

The hash is any stable, deterministic string that changes when the file content
changes. Recommended options:

| Method | Example value | Notes |
|---|---|---|
| SHA-256 (truncated) | `a1b2c3d4` | Best — true content hash |
| MD5 | `d41d8cd9` | Widely available, not cryptographic |
| ETag | `"abc-123"` | Use the raw ETag value from your CDN/server |
| Build hash | `abc123` | Hash injected by your bundler (Webpack, Vite, etc.) |

The hash does **not** need to be cryptographically secure — it is only used for
equality comparison.

---

## What Files to Include

Include **every file that NLPWA should manage in its caches**:

✅ Include:
- All files in `config.precache`
- All static assets served to the browser (JS, CSS, HTML, images, fonts)
- Any file that a fetch strategy might cache at runtime

❌ Do not include:
- API responses (dynamic, user-specific)
- Server-side resources not directly served to the browser
- The manifest itself (`/api/manifest/latest`)

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

Updates are checked in three ways:

| Trigger | Who | Frequency |
|---|---|---|
| Activation | SW | Every time the SW activates (app open / reload) |
| Polling interval | SW | Every `config.updateCheckInterval` ms |
| Tab focus | Client | Throttled by `options.focusThrottleMs` (default: 5 min) |
| Manual | Client | Via `postMessage({ type: 'CHECK_UPDATE' })` |

A concurrency lock prevents two update runs from overlapping regardless of
which trigger fires.
