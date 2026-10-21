# NLPWA — Features & Capabilities Reference

NLPWA (Native-like Progressive Web App) is an enterprise-grade Service Worker framework designed to eliminate the fragility, version drift, and deployment hazards that plague traditional PWAs. 

This document provides a comprehensive guide to NLPWA's architecture, reliability guarantees, security model, and developer tooling.

---

## Table of Contents

1. [Atomic Over-The-Air (OTA) Updates](#1-atomic-over-the-air-ota-updates)
2. [Client Version Pinning & Zero Drift](#2-client-version-pinning--zero-drift)
3. [Cryptographic Manifest Signing (Ed25519)](#3-cryptographic-manifest-signing-ed25519)
4. [Deploy Safety, Release Channels & Phased Rollouts](#4-deploy-safety-release-channels--phased-rollouts)
5. [Health-Gated Commits & Boot Watchdog Rollback](#5-health-gated-commits--boot-watchdog-rollback)
6. [Resumable & Budgeted Staging](#6-resumable--budgeted-staging)
7. [Multi-Tab Consensus Bus & Dirty Form Protection](#7-multi-tab-consensus-bus--dirty-form-protection)
8. [Runtime Observability & Diagnostics API](#8-runtime-observability--diagnostics-api)
9. [Modular Micro-Kernel & Plugin Ecosystem](#9-modular-micro-kernel--plugin-ecosystem)
10. [Native OS Integrations](#10-native-os-integrations)
11. [Developer CLI & CI/CD Workflow](#11-developer-cli--cicd-workflow)

---

## 1. Atomic Over-The-Air (OTA) Updates

Traditional Service Worker setups force an all-or-nothing re-registration of the Service Worker script whenever any application file changes. During this process, active tabs risk loading mixed-version scripts or hitting 404 chunk errors.

NLPWA solves this by decoupling the **Service Worker engine lifecycle** from the **Application asset lifecycle**:

- **Decoupled Engine:** The Service Worker (`sw.js`) installs once and stays running indefinitely. Application updates arrive Over-The-Air (OTA) as lightweight JSON manifests (`version.json` and `info.json`).
- **Two-Tier Update Polling:**
  - **Tier 1:** Polls `/api/update/version.json` (~20 bytes). If the remote version matches the currently active version, the check stops immediately with zero network overhead.
  - **Tier 2:** If a new version is detected, downloads `/api/update/info.json` containing the file list and content digests.
- **Isolated Staging Cache:** Updates are staged into a separate, isolated cache (`offline@<targetVersion>-<id>`). Active tabs continue serving from their current cache uninterrupted.
- **Local Diff Copying (Zero Network Bytes):** Files whose SHA-256 hashes match the currently running version are cloned directly from the active cache locally inside the browser. Only altered files are fetched over the network.
- **SHA-256 Digest Verification:** In-flight downloads are validated against manifest SHA-256 hashes before being stored, preventing corrupt chunks, captive portal login pages, and CDN truncation from ever entering the cache.
- **Atomic Pointer Switch:** Only when 100% of files are downloaded, verified, and indexed with `snapshot.json` does the active cache pointer atomically update in `nlpwa-meta`. You never experience a "half-updated" state.

```
Active Tab (Reading offline@v1)             Staging Cache (offline@v2)
       │                                              │
       ├─ Subresource: /chunk-a.js ───────────────────┼─ Background fetch /chunk-b.js
       │  (Served safely from v1)                     ├─ Verify SHA-256 digest
       │                                              ├─ Copy unchanged /chunk-a.js locally
       │                                              └─ Write snapshot.json (Complete!)
       │                                                       │
       ├───────────────────────────────────────────────────────┴─ Atomic Pointer Flip
       ▼                                                          Switched to offline@v2
Next Navigation → Pinned to offline@v2
```

---

## 2. Client Version Pinning & Zero Drift

In single-page applications (SPAs), dynamically imported chunks (`import('./route.js')`) often change their bundle hashes between releases. When an update commits while a user is working, a standard Service Worker deletes old caches, causing immediate `ChunkLoadError` failures when the user navigates.

NLPWA guarantees **Zero Version Drift** through per-client pinning:

- **Per-Tab Isolation (`clientId`):** When a browser tab boots, the Service Worker inspects its active version and pins that specific `clientId` to its current cache store (`offline@v1`).
- **Subresource Coherence:** All subresource requests (CSS, JS chunks, images) issued by that tab are served from its pinned version, regardless of whether a newer version has staged or activated in another tab.
- **Navigation Grace Window (30s):** During page reloads and cross-document transitions, a 30-second grace window protects unpinned navigations while documents initialize and re-establish their client session.
- **`minVersion` Breaking Change Guard:** When backend APIs undergo breaking changes, setting `minVersion` (or `minSupportedVersion`) in `version.json` causes the Service Worker to automatically drop obsolete pins, broadcast an `UPDATE_REQUIRED` event, and prompt or force an upgrade.

---

## 3. Cryptographic Manifest Signing (Ed25519)

Transport-level HTTPS protects data between the browser and CDN, but does not protect against compromised CDN credentials, rogue origin writes, or cache poisoning.

NLPWA includes end-to-end cryptographic integrity via detached **Ed25519 signatures**:

```
[Developer Machine / CI]
  .env (NLPWA_PRIVATE_KEY) ──> nlpwa update ──> info.json (with base64 signature)
                                                        │
                                                        ▼
[User Browser]                                   HTTPS CDN / Server
  Service Worker (publicKey) <── fetch(info.json) ──────┘
         │
         ├── Web Crypto: crypto.subtle.verify(publicKey, signature, payload)
         │   ├── Invalid / Tampered? ──> Stage Aborted + Security Warning
         │   └── Valid?              ──> Proceed with Staging
```

- **Built-in Key Generator:** Generate cryptographically secure Ed25519 keypairs using `npx nlpwa keys:generate`, which securely appends `NLPWA_PRIVATE_KEY` to your local `.env` and exports the public key to `nlpwa.config.js`.
- **Zero-Dependency CLI Signer:** `nlpwa update` automatically signs canonical manifest representations at build time using Node's native `crypto.sign`.
- **Hardware-Accelerated Web Crypto:** The Service Worker verifies detached signatures using standard browser `crypto.subtle.verify("Ed25519", ...)` before downloading any files.
- **Detached & Non-Intrusive:** The signature is stored directly in `info.json` under the `signature` field, requiring no changes to HTML subresource tags.

---

## 4. Deploy Safety, Release Channels & Phased Rollouts

NLPWA brings native mobile app deployment controls to the open web:

### Remote Kill-Switch (`blockedVersions`)
If a release containing a critical runtime bug slips into production, you can instantly revoke it without redeploying the Service Worker:
```json
{
  "version": "2.4.0",
  "blockedVersions": ["2.3.9", "2.3.8"]
}
```
When the Service Worker receives `blockedVersions`:
1. It immediately unpins any client currently running a blocked version.
2. It evicts the blocked cache from browser storage.
3. It broadcasts an `UPDATE_REQUIRED` event to all open tabs and forces fallback or reload to a safe release.

### Phased Cohort Rollouts (`rolloutPercent`)
Roll out updates gradually (e.g., 10% → 25% → 100%) to mitigate risk:
```json
{
  "version": "3.0.0",
  "rolloutPercent": 25
}
```
- **Deterministic Cohort Hashing:** Each browser client has a stable, anonymized client identifier. The Service Worker hashes this ID to place the client into a persistent 0–99 percentile bucket.
- **Consistent User Experience:** A user in the 25% bucket stays in the 25% bucket across sessions—never flickering between versions.

### Release Channels (`stable` vs. `beta`)
Support internal testers, pre-releases, and production channels on the same origin:
```javascript
// In nlpwa.config.js or via client subscription:
nlpwa.subscribeChannel('beta');
```
Clients on the `stable` channel ignore `beta` manifests, while `beta` testers receive cutting-edge OTA updates.

---

## 5. Multi-Boot Probation & First-Party Error Filtering

One of the greatest fears in web deployment is pushing a build with a syntax error or runtime initialization crash that locks users into a broken offline cache. However, a brittle single-strike watchdog can cause false-alarm rollbacks triggered by browser extension bugs or ad-blocker network drops.

NLPWA implements **Multi-Boot Probation with First-Party Error Filtering**:

```
[New Version Committed]
         │
         ├── Enters 'probation' state (Stored in IndexedDB)
         ├── Retain previous known-good version as fallback cache
         │
         ├── First-Party Error Filter:
         │   ├── Ignores chrome-extension://, moz-extension://, safari-web-extension://
         │   ├── Ignores cross-origin scripts (GTM, ads, 3rd-party trackers)
         │   └── Counts ONLY first-party application crashes
         │
         ├── Probation Verification:
         │   ├── Boot Healthy ──> healthyBoots++
         │   │   └── Reaches threshold (default: 2 healthy boots) ──> Promotes to STABLE & sweeps fallback
         │   │
         │   └── Boot Failure ──> consecutiveFailures++
         │       └── Single failure: Logged, probation continues (doesn't immediately block release)
         │       └── 2 Consecutive Failures: Automatic Rollback to fallback cache
         │           ├── Reverts active pointer atomically
         │           ├── Adds version to client-side blockedVersions (with 24h expiration TTL)
         │           └── Broadcasts ROLLBACK_APPLIED to clients
```

### Configuration & Developer Usage:
```javascript
// nlpwa.config.js
export default {
  version: '1.0.0',
  verifyHashes: 'warn', // Default 'warn' protects against CDN minification breaking staging
  probation: {
    requiredHealthyBoots: 2, // Must boot healthily twice to clear probation
    failureThreshold: 2,     // 2 consecutive first-party failures required before rollback
    clientBlockTtlMs: 86400000, // 24-hour expiration TTL for client-side blocks
  },
  largeFileThresholdBytes: 25 * 1024 * 1024, // >25MB delegates to Background Fetch & IDB
  applyMode: 'navigation', // Stage in background, apply atomically on next full HTML navigation
  telemetry: false, // Opt-in reporting hook (/api/report)
};
```

### Client API:
```javascript
import { nlpwa, isFirstPartyError, requestPersistentStorage } from 'nlpwa/client';

// App entry point
async function initApp() {
  try {
    await renderApplication();
    
    // Disarm watchdog and record healthy boot towards probation completion
    nlpwa.markHealthy();
  } catch (err) {
    if (isFirstPartyError(err)) {
      nlpwa.reportBootFailure(err);
    }
  }
}

// Request persistent storage on user gesture or post-install
button.addEventListener('click', () => {
  requestPersistentStorage();
});
```

---

## 6. Resumable & Budgeted Staging

Updating web apps over mobile data or metered connections requires respect for user bandwidth:

- **`saveData` Respect:** If the user has Data Saver enabled in their browser (`navigator.connection.saveData === true`), NLPWA halts non-essential background delta downloads until the user enters an unmetered connection or explicitly triggers an update.
- **`maxUpdateBytes` Cap:** Prevents rogue builds or massive asset additions from overwhelming client storage. If cumulative delta download size exceeds the configured budget, staging pauses and prompts the user.
- **`wifiOnlyThresholdBytes`:** Automatically restricts updates larger than a specified size (e.g., > 15MB) to Wi-Fi connections, preserving cellular data plans.
- **Resumable Staging Checkpoints:** Network drops or browser process kills during staging do not restart downloads from scratch. Staged assets already verified in IndexedDB/CacheStorage are preserved across sessions.

---

## 7. Multi-Tab Consensus Bus & Dirty Form Protection

When an update is staged and ready, automatically reloading the browser can cause catastrophic data loss if the user is typing an uncommitted form, editing a document, or midway through a checkout flow.

NLPWA provides an inter-tab consensus engine:

- **BroadcastChannel Tab Bus:** Open tabs communicate over `nlpwa-tab-bus`, coordinating update prompts and state transitions.
- **Tab Leader Election:** Uses the Web Locks API (`navigator.locks`) to elect a single active leader tab responsible for coordinating background polling and update notifications.
- **Dirty Form Reload Guard:**
  ```javascript
  import { nlpwa } from 'nlpwa/client';

  // Mark current tab as containing unsaved work
  nlpwa.setDirty(true);

  // Or register a dynamic guard function
  nlpwa.registerDirtyGuard(() => {
    return editor.hasUnsavedChanges();
  });

  // Query consensus across all open browser tabs
  const { canReload, dirtyTabs } = await nlpwa.checkDirtyTabs();
  if (!canReload) {
    console.warn(`Cannot auto-reload: ${dirtyTabs.length} tabs have unsaved edits.`);
  }
  ```

---

## 8. Runtime Observability & Diagnostics API

Inspect the internal health and cache state of your PWA at any moment:

```javascript
import { nlpwa } from 'nlpwa/client';

const diag = await nlpwa.diagnostics();
console.log(diag);
```

### Diagnostics Payload:
```json
{
  "activeVersion": "2.4.0-a1b2c3d4e5f6",
  "pinnedVersion": "2.4.0-a1b2c3d4e5f6",
  "isPinned": true,
  "stagedVersion": null,
  "stagingProgress": { "completed": 12, "total": 12, "percent": 100 },
  "fallbackAvailable": true,
  "blockedVersions": ["2.3.9"],
  "channel": "stable",
  "storage": {
    "usageBytes": 14208000,
    "quotaBytes": 2147483648,
    "percentUsed": 0.66
  },
  "isLeader": true,
  "dirtyState": false
}
```

---

## 9. Modular Micro-Kernel & Plugin Ecosystem

NLPWA's Service Worker engine is designed as an ultra-lightweight micro-kernel (~4KB min/gzip) focused purely on offline caching, fetch strategies, and atomic updates. Specialized capabilities are imported as zero-dependency modular plugins:

| Plugin | Export Path | Bundle Size | Purpose |
|---|---|---|---|
| **Core SW** | `nlpwa/sw` | ~4 KB | Offline routing, caching strategies, atomic OTA updater |
| **Core Client** | `nlpwa/client` | ~3 KB | Registration, update prompts, reactive state, tab bus |
| **Background Sync** | `nlpwa/sync` | ~3 KB | Offline POST/PUT queue, automatic replay, dead-letter store |
| **Web Share Target** | `nlpwa/share` | ~1.5 KB | OS share sheet listener, FIFO payload queue, size protection |
| **OS App Badging** | `nlpwa/badge` | ~1 KB | App icon badge counter, auto-clear on push notification click |
| **Background Fetch** | `nlpwa/bg-fetch` | ~1.5 KB | Large asset background downloads with OS progress indicators |
| **Ed25519 Crypto** | `nlpwa/crypto` | ~1.2 KB | Web Crypto detached signature verification utilities |

### Using Modular Plugins:

```javascript
// In sw.js:
import { initSW } from 'nlpwa/sw';
import { BackgroundSyncPlugin } from 'nlpwa/sync';
import { ShareTargetPlugin } from 'nlpwa/share';

initSW({
  plugins: [
    new BackgroundSyncPlugin({ maxRetentionMs: 86400000 }),
    new ShareTargetPlugin({ action: '/_share-target' }),
  ],
});
```

```javascript
// In application client code:
import { nlpwa } from 'nlpwa/client';
import { setBadge, clearBadge } from 'nlpwa/badge';
import { syncClient } from 'nlpwa/sync/client';

// Update OS icon badge
await setBadge(3);

// Query offline mutation queue
const { count } = await syncClient.getPending('my-queue');
```

---

## 10. Native OS Integrations

In addition to enterprise update guarantees, NLPWA provides seamless wrappers for native browser APIs:

- **PWA Installation Manager:** Automatically captures and defers `beforeinstallprompt`, preserving the prompt across navigations and exposing `nlpwa.install()`.
- **Persistent Storage:** Protect offline caches from browser eviction under storage pressure via `nlpwa.requestPersistentStorage()`.
- **Unified Reactive State Store:** `nlpwa.subscribe((state) => ...)` exposes unified status (`online`, `updateStatus`, `badgeCount`, `isInstallable`) for React, Vue, Svelte, or vanilla JS.
- **Dead-Letter Storage:** Offline mutations that fail permanently with 4xx errors are preserved in IndexedDB dead-letter storage rather than lost, allowing manual inspection and retry.

---

## 11. Developer CLI & CI/CD Workflow

The `nlpwa` CLI automates the entire PWA build, signature, and deployment lifecycle:

```bash
# 1. Initialize a new project with starter configs and icons
npx nlpwa init --dir ./public

# 2. Generate cryptographically secure Ed25519 keys
npx nlpwa keys:generate

# 3. Add optional standalone plugins to no-build static projects
npx nlpwa add sync
npx nlpwa add share
npx nlpwa add badge

# 4. Hash assets, compile runtime config, and sign manifests
npx nlpwa update --dir ./dist

# 5. Check integrity and active version of build output
npx nlpwa status --dir ./dist
```

### Zero-Config Bundler Plugins:
First-class plugins are included for **Vite**, **Rollup**, and **Webpack** (`nlpwa/vite`, `nlpwa/rollup`, `nlpwa/webpack`) to run hash updates automatically upon build completion.
