# NLPWA — Native-like PWA Framework

[![npm version](https://img.shields.io/npm/v/nlpwa.svg?color=0284c7&style=flat-square)](https://www.npmjs.com/package/nlpwa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Zero Runtime Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg?style=flat-square)](https://github.com/arif891/nlpwa)
[![Tests Passing](https://img.shields.io/badge/tests-332%20passing-brightgreen.svg?style=flat-square)](https://github.com/arif891/nlpwa)
[![Core Size](https://img.shields.io/badge/core%20SW%20size-%3C4%20KB%20gz-informational.svg?style=flat-square)](https://github.com/arif891/nlpwa)

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It delivers **atomic over-the-air (OTA) delta updates**, **per-tab client version pinning**, **cryptographic manifest signing (Ed25519)**, **automated health-gated rollbacks**, and **modular plugins** — all from drop-in files or npm subpath exports.

> [!NOTE]
> **Prototype Stage:** NLPWA is currently in prototype development and under active evolution. For a complete deep dive into all capabilities, see the [**FEATURES.md**](docs/FEATURES.md) reference guide. Feedback, issues, and contributions are very welcome!

---

## Table of Contents

- [The Core Problem: Why Most PWAs Feel Fragile](#the-core-problem-why-most-pwas-feel-fragile)
- [Core Capabilities](#core-capabilities)
- [🚀 Works Out of the Box, Security When You Need It](#-works-out-of-the-box-security-when-you-need-it)
- [NLPWA vs. Workbox](#nlpwa-vs-workbox)
- [Built-in Native OS Integrations](#built-in-native-os-integrations)
- [Quick Start](#quick-start)
- [Live Interactive Showcase](#live-interactive-showcase)
- [Modern Framework Recipes (React, Vue, Vanilla)](#modern-framework-recipes)
- [File Roles: Edit vs. Drop-in vs. Generated](#file-roles-what-do-i-edit-vs-what-do-i-copy--generate)
- [⚠️ Critical Rule: Precache Atomicity Guarantee](#️-critical-rule-precached-files-are-strictly-cache-first-non-overridable)
- [🛡️ Minimum Supported Version (`minVersion`)](#️-minimum-supported-version-minversion-breaking-api-protection)
- [Solving Version Skew: Traditional PWAs vs. NLPWA](#solving-version-skew-traditional-pwas-vs-nlpwa)
- [Integrity & Cryptographic Signatures](#integrity-operational-verification-vs-cryptographic-signatures)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Documentation Hub](#documentation-hub)
- [Development & Build Outputs](#development)
- [License](#license)

---

## The Core Problem: Why Most PWAs Feel Fragile

In traditional Service Worker setups, managing application updates presents a difficult dilemma:

1. **Infinite Waiting Workers (Default Behavior):** Tools like Workbox do not call `skipWaiting()` by default. When an update installs, the new service worker sits waiting in the background until *all* open tabs and windows running the app are completely closed. Users stay trapped on obsolete versions indefinitely.
2. **Version Drift / Broken Tabs (with `skipWaiting`):** If developers enable `skipWaiting` to bypass the waiting worker, the new service worker activates immediately and swaps cached assets out from underneath active tabs. When an existing tab navigates or dynamically imports a chunk, it requests older bundle hashes that no longer exist in the newly activated cache, triggering fatal `404 ChunkLoadError` crashes or loading mixed-version state.

**NLPWA eliminates both problems through Decoupled OTA Deltas, Client Version Pinning, and Health-Gated Deploys.**

---

## Core Capabilities

- **Atomic Over-The-Air (OTA) Updates** — Updates stage into an isolated delta cache in the background. Only after 100% of files are downloaded and verified does the version atomically flip. You never get half-updated states.
- **Client Version Pinning (Zero Version Drift)** — Each open tab is pinned to the exact version it booted with. Subresource requests continue serving from that version until the tab navigates or the user confirms an update banner.
- **Cryptographic Manifest Signing (Ed25519)** — Manifests are signed at build time with a detached Ed25519 signature; the Service Worker validates the signature via Web Crypto before staging files, locking out compromised CDNs.
- **Health-Gated Commits & Boot Watchdog Rollback** — Retains a fallback cache across updates. If an activated release fails to boot or times out, the Service Worker automatically rolls back to the known-good version.
- **Deploy Safety & Phased Rollouts** — Target users via `rolloutPercent` cohort percentiles, isolate pre-releases via release `channel` (`stable`/`beta`), or instantly revoke bad versions using the remote `blockedVersions` kill-switch.
- **Resumable & Budgeted Staging** — Respects `navigator.connection.saveData`, enforces maximum update byte quotas, halts large downloads on cellular, and resumes interrupted staging checkpoints.
- **Multi-Tab Consensus & Dirty Form Protection** — Open tabs coordinate over `nlpwa-tab-bus`. Tab leader election guards active sessions, while `registerDirtyGuard()` blocks update reloads when users have unsaved edits.
- **Decoupled SW vs. App Lifecycle** — The Service Worker engine installs once and stays running. App releases arrive as data-driven OTA deltas without worker re-registration churn.
- **Modular Micro-Kernel & Plugin Ecosystem** — Ultra-lightweight core engine with modular zero-dependency plugins for Background Sync & Periodic Sync (`nlpwa/sync`), Web Push (`nlpwa/push`), Web Share Target (`nlpwa/share`), OS App Badging (`nlpwa/badge`), and Background Fetch (`nlpwa/bg-fetch`).

---

## 🚀 Works Out of the Box, Security When You Need It

NLPWA is designed to **just work out of the box** without friction, while providing a **progressive security dial** for high-assurance production environments.

### 1. Resilient & Frictionless by Default (Works Out of the Box)
- **Zero-Friction Init:** Run `npx nlpwa init` and you immediately have a working PWA with offline caching and atomic OTA updates. No keys to generate or certs to manage.
- **Resilient Hash Verification (`verifyHashes: 'warn'`):** CDN transformations, proxy minification, or dynamic edge compression won't fail your update staging. Warnings are logged, but the release is safely applied.
- **Background Staging & Navigation Apply (`applyMode: 'navigation'`):** Updates stage completely in the background and activate seamlessly on the next page navigation. Never interrupts a user mid-session and never refreshes over dirty form inputs.
- **Large File Auto-Delegation (>25MB):** Large assets (3D models, video, WASM weights) automatically delegate to the browser's Background Fetch API and stream directly into IndexedDB, avoiding memory spikes in `CacheStorage`.
- **Multi-Boot Probation with Error Filtering:** Newly committed releases must boot healthily twice to clear probation. The boot watchdog automatically filters out browser extension crashes (`chrome-extension://`) and cross-origin noise (GTM, ads, Sentry), requiring 2 consecutive first-party failures before rolling back.
- **Respectful Storage & Telemetry:** Storage persistence is deferred to `appinstalled` or explicit user gestures rather than unprompted permission dialogs on page load. Telemetry is strictly off by default.

### 2. Optional Progressive Security (Dial Up When Needed)
For high-assurance deployments with strict integrity requirements, security can be dialed up on-demand:
- **Ed25519 Cryptographic Manifest Signing:** Provide `signingKey` in CI and `publicKey` in config. The Service Worker validates detached signatures via Web Crypto before staging files, completely locking out compromised CDNs.
- **Strict SHA-256 Digest Verification (`verifyHashes: 'strict'`):** Abort staging immediately if a single byte differs from the manifest.
- **Minimum Supported Version Floor (`minVersion`):** Automatically evict and upgrade clients running outdated code below your security baseline.
- **Remote Emergency Kill-Switch (`blockedVersions`):** Instantly revoke vulnerable releases origin-wide.
- **Phased Cohorts & Release Channels (`rolloutPercent`, `channel`):** Safely canary updates to 10% or 25% of users before wider rollout.

---

## NLPWA vs. Workbox

| Dimension / Capability | Workbox | NLPWA |
|---|---|---|
| **Architectural Model** | **Modular Toolkit.** A collection of libraries (`workbox-*`) for assembling custom service workers. | **Integrated App Framework.** A pre-bundled engine, runtime SDK, and build tool designed specifically for atomic OTA app releases. |
| **SW Lifecycle vs. App Updates** | **Bound to SW Lifecycle.** Precache changes require re-compiling `sw.js`, triggering full worker update cycles (`install` → `waiting` → `activate`). | **Decoupled Engine & App.** The SW engine remains active; application updates arrive Over-The-Air via lightweight JSON manifests (`version.json` / `info.json`). |
| **Open Tab Isolation** | ⚠️ **No per-tab isolation.** By default, workers wait until all tabs close. If `skipWaiting` is enabled, open tabs suffer version drift and lazy-chunk 404s. | ✅ **Built-in Client Version Pinning.** Every open tab is isolated by `clientId` to its active boot cache; existing tabs never experience mixed-version states mid-session. |
| **Delta Downloads** | **Revision-based precache.** Modified assets are downloaded during worker installation; unchanged files are retained in the precache store. | **Local hash diffing.** Unchanged files are copied locally from the active cache (zero network bytes); changed files are staged and verified in an isolated cache. |
| **Atomic Staging** | ❌ **Live in-place mutation.** Precache entries are populated directly into the new worker's cache during `install`. | ✅ **Isolated delta staging cache.** Updates commit atomically via metadata pointer only when 100% of files are downloaded and verified. |
| **Integrity & Signatures** | URL revision string comparison / optional Subresource Integrity (SRI) on precache entries. | In-transit SHA-256 digest verification + optional build-time **Ed25519 cryptographic manifest signing**. |
| **Deploy Safety & Rollback** | ❌ **No built-in rollback.** Bad deployments require manual app handling or rolling forward a new release. | ✅ Built-in **automatic boot watchdog rollback** to previous known-good version (`nlpwa-fallback`). |
| **Phased Rollouts & Kill-Switch** | ❌ Requires custom proxy routing or manual worker logic. | ✅ Built-in **`rolloutPercent`** cohorts, release channels (`stable`/`beta`), and remote **`blockedVersions`** kill-switch. |
| **Multi-Tab Consensus** | ❌ Requires custom window `postMessage` coordination. | ✅ Built-in **BroadcastChannel tab bus**, leader election, and dirty form reload guards (`registerDirtyGuard`). |
| **Breaking Version Guard** | ❌ Requires custom messaging or server-side version negotiation. | ✅ Built-in **`minVersion`** enforcement that unpins outdated tabs and auto-prompts/forces reload. |
| **Deploy Workflow** | Must re-compile / re-inject `sw.js` every build. | `sw.js` stays static; CLI emits lightweight JSON update manifests. |
| **Dependencies** | Modular npm packages (`workbox-*`). | **Zero runtime dependencies** (drop-in pre-bundled files or npm subpath exports). |
| **Modular Plugins** | Monolithic plugin hooks runner. | Official plugins: `sync`, `push`, `share`, `badge`, `bg-fetch`, `crypto`. |

### When to Choose Workbox
Workbox remains the standard choice for:
- Bespoke service worker pipelines with custom stream transformations or complex multi-worker topologies.
- Existing integrations with Webpack (`workbox-webpack-plugin`) or Next.js PWA plugins (`next-pwa` / `@ducanh2912/next-pwa`).
- Specialized requirements like Google Analytics offline queueing (`workbox-google-analytics`).

### When to Choose NLPWA
NLPWA is ideal when you want:
- Native-like Over-The-Air (OTA) updates where app releases don't cause Service Worker reinstall churn.
- Guaranteed multi-tab asset consistency with zero risk of mid-session chunk-loading 404s.
- Turnkey batteries: background sync queue with dead-letter recovery, form-edit reload protection, storage quota cleanup, and CLI tooling out of the box.

---

## Built-in Native OS Integrations

In addition to atomic updates, NLPWA provides zero-dependency native OS wrappers:
- **PWA Installation Manager** — Captures `beforeinstallprompt` automatically, persists deferred prompt across navigation, and exposes `nlpwa.promptInstall()`.
- **Persistent Storage** — `nlpwa.requestPersistentStorage()` guards offline caches from browser eviction under storage pressure.
- **Unified Reactive State Store** — `nlpwa.subscribe((state) => ...)` exposes unified status (`online`, `updateStatus`, `badgeCount`, `isInstallable`) for React, Vue, Svelte, or vanilla JS.
- **Web Push Notifications** — Progressive Web Push subscription management with VAPID key conversion and interactive action routing (`nlpwa/push`).
- **OS Badging API** — `nlpwa.setAppBadge()` / `nlpwa.clearAppBadge()` (or `nlpwa/badge`) sets app icon badges across Windows, macOS, Android, and iOS.
- **Web Share Target** — Intercepts system share sheet submissions (files, text, URLs) into a safe FIFO queue with size protection (`nlpwa/share`).
- **Background Sync & Periodic Sync** — Queue offline `POST`/`PUT`/`DELETE` mutations in IndexedDB with automatic replay, dead-letter storage, and periodic tasks with progressive fallback (`nlpwa/sync`).
- **Diagnostics API** — `nlpwa.getDiagnostics()` returns real-time storage metrics, pin states, fallback availability, and leader status.

---

## Quick Start

### 1. Initialize in Your Project

```bash
# Drop sw.js, client.js, and nlpwa.config.js into current directory
npx nlpwa init

# Or target your public or build directory
npx nlpwa init --dir ./public
```

Your project directory now has the core drop-in files:
```
your-app/
├── sw.js            ← Service Worker engine (pre-built, drop-in)
├── client.js        ← Client runtime SDK (pre-built, drop-in)
├── nlpwa.config.js  ← Project configuration (version, precache, routes)
├── assets/
│   ├── other/
│   │   └── manifest.webmanifest ← W3C Web App Manifest
│   └── image/icon/
│       ├── icon-192.png         ← 192x192 PNG icon
│       ├── icon-512.png         ← 512x512 PNG icon
│       └── icon.svg             ← Maskable vector icon
└── index.html
```

### 2. Configure Your App in `nlpwa.config.js`

```javascript
// nlpwa.config.js
export default {
  version: '1.0.0',

  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },

  // App shell files to track and offline-cache
  precache: [
    '/',
    '/index.html',
    '/client.js',
    '/assets/other/manifest.webmanifest',
    '/assets/image/icon/icon-192.png',
    '/assets/image/icon/icon-512.png',
    '/assets/image/icon/icon.svg',
  ],

  // Per-route fetch strategies (evaluated top-to-bottom)
  routes: [
    { match: '/api/**',       strategy: 'network-only' },
    { match: '/assets/**',    strategy: 'cache-first'  },
    { match: '/pages/**',     strategy: 'network-first', networkTimeoutMs: 3000 },
    { match: '/_feeds/**',    strategy: 'stale-while-revalidate' },
  ],
  defaultStrategy: 'network-first',
};
```

### 3. Register from Your HTML / Client

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="manifest" href="/assets/other/manifest.webmanifest">
  <script src="/client.js"></script>
</head>
<body>
  <div id="update-banner" hidden>
    A new version is available.
    <button onclick="NLPWAClient.applyUpdate()">Refresh</button>
  </div>

  <button id="install-btn" hidden onclick="NLPWAClient.nlpwa.promptInstall()">Install App</button>

  <script>
    const { nlpwa, register } = NLPWAClient;

    // 1. Register Service Worker
    register('/sw.js', {
      onUpdateReady: ({ version }) => {
        document.getElementById('update-banner').hidden = false;
      },
    });

    // 2. Reactive status & install button
    nlpwa.subscribe((state) => {
      document.getElementById('install-btn').hidden = !state.isInstallable;
    });
  </script>
</body>
</html>
```

*(Using a bundler? Import `import { nlpwa, register, applyUpdate } from 'nlpwa/client'` instead).*

### 4. Build and Hash with the CLI

```bash
# Computes deterministic content hashes (e.g. 1.0.0-a1b2c3d4e5f6) and outputs to ./dist
npx nlpwa update --dir ./dist
```

This generates:
- `dist/api/update/config.json` (compiled runtime config for the SW offline cache)
- `dist/api/update/version.json` (`{ "version": "1.0.0-a1b2c3d4e5f6" }`)
- `dist/api/update/info.json` (`{ "version": "1.0.0-a1b2c3d4e5f6", "files": [...] }`)

---

## Live Interactive Showcase

NLPWA includes a complete demo app with an interactive caching strategy playground, live metrics, and real-time OTA version bump simulations:

```bash
# Clone the repository
git clone https://github.com/arif891/nlpwa.git
cd nlpwa

# Install and build
npm install
npm run build

# Start the showcase server
npm run example
```
Open **`http://localhost:3000`** in your browser to test offline caching, trigger OTA updates via the simulation button, and inspect multi-tab version pinning live.

---

## Modern Framework Recipes

The `nlpwa.subscribe()` store coordinates seamlessly with all major reactive front-end frameworks:

### React / Next.js Hook

```tsx
import { useEffect, useState } from 'react';
import { nlpwa, applyUpdate } from 'nlpwa/client';

export function UpdateToast() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    return nlpwa.subscribe((state) => {
      setUpdateReady(state.updateStatus === 'ready');
    });
  }, []);

  if (!updateReady) return null;

  return (
    <aside className="update-toast">
      <span>A new version is ready.</span>
      <button onClick={() => applyUpdate()}>Update & Reload</button>
    </aside>
  );
}
```

### Vue 3 Composition API

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { nlpwa, applyUpdate } from 'nlpwa/client';

const isInstallable = ref(false);
const updateReady = ref(false);

let unsubscribe;
onMounted(() => {
  unsubscribe = nlpwa.subscribe((state) => {
    isInstallable.value = state.isInstallable;
    updateReady.value = state.updateStatus === 'ready';
  });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});
</script>

<template>
  <div>
    <button v-if="isInstallable" @click="nlpwa.promptInstall()">Install App</button>
    <div v-if="updateReady">
      <span>New version available!</span>
      <button @click="applyUpdate()">Refresh</button>
    </div>
  </div>
</template>
```

---

## File Roles: What Do I Edit vs. What Do I Copy / Generate?

| File | Type | Do I edit it? | Role & Description |
|---|---|---|---|
| **`nlpwa.config.js`** | Source | ✏️ **Yes — Edit this** | Your primary configuration. Define app version, precached shell files, and route strategies. |
| **`sw.js`** | Core Engine | 📋 **Copy / Drop-in** | The pre-bundled Service Worker engine. Copied into your project by `nlpwa init` (or imported via `nlpwa/sw`). |
| **`client.js`** | Client SDK | 📋 **Copy / Drop-in** | The client runtime script. Exposes `window.NLPWAClient` / `register()`, handles update prompts, and provides cache management. |
| **`api/update/config.json`** | Runtime Data | ⚙️ **Generated / Deployed** | Emitted automatically into your build directory (`dist/api/update/config.json`) by `nlpwa update` from `nlpwa.config.js` and loaded into the offline cache. |
| **`api/update/*`** | Manifests | ⚙️ **Generated / Deployed** | Generated by `nlpwa update` (`version.json` and `info.json`). These are the static HTTP endpoints your Service Worker polls for OTA delta updates. |

---

## ⚠️ Critical Rule: Precached Files Are Strictly Cache-First (Non-Overridable)

All files declared in your `precache` array (your HTML shell, JS bundles, CSS, and icons) are **always served `cache-first` directly from the active offline cache**, regardless of custom route rules or your `defaultStrategy`.

> [!IMPORTANT]
> **Precache Overrides Any Route Strategy to Protect Atomicity**
> If you configure `{ match: '/app.js', strategy: 'network-first' }` or `{ match: '/index.html', strategy: 'network-only' }`, NLPWA will **ignore** that strategy for `/app.js` and `/index.html` if they are in `precache`.
>
> - **Why this protects you (Atomicity Guarantee):** If precached files could be fetched raw from the network, a client could load a live v2 HTML shell while still running v1 cached scripts (or vice-versa), causing fatal runtime version skew.
> - **The Gotcha (Hotfixing):** You cannot hotfix a precached asset by simply pushing an updated file to your server or switching a route rule. The Service Worker will continue serving the active version from `offline@<version>`.
> - **The Solution (Correct Update Flow):** Run `npx nlpwa update` (or let your CI/CD build run) to emit a new version and update manifests (`version.json` / `info.json`). NLPWA will detect the change, stage the delta update in the background with SHA-256 verification, and activate the hotfix atomically.

---

## 🛡️ Minimum Supported Version (`minVersion`): Breaking API Protection

Client version pinning guarantees that existing tabs are never corrupted mid-session. However, in real-world mobile deployments, users may leave tabs open for days or weeks while your backend API migrates from `v1` to `v3`.

To prevent long-lived pinned tabs from calling deprecated or incompatible backend endpoints, include a `minVersion` (or `minSupportedVersion`) field in your `version.json` or `info.json`:

```json
{
  "version": "3.2.0",
  "minVersion": "2.0.0"
}
```

### What happens when `minVersion` is published:
1. **Pins Dropped:** The Service Worker automatically drops version pins for any client pinned to a version below `minVersion`.
2. **`UPDATE_REQUIRED` Broadcast:** Connected client tabs receive an `UPDATE_REQUIRED` event containing the required version and target version.
3. **Auto-Reload or Prompt:** If you configured `onUpdateRequired`, your custom UI can inform the user. Otherwise, `NLPWAClient.register()` cleanly reloads the application so the tab migrates to the current supported version.

---

## Solving Version Skew: Traditional PWAs vs. NLPWA

In traditional Progressive Web Apps, application files and Service Worker scripts are tightly coupled:

### Traditional Service Worker Skew Problem
```
Tab 1 (Running v1 Code)               Waiting Worker (v2)
       │                                     │
       ├─ User triggers lazy chunk /auth.js  │
       │  (Requests v1 chunk from network)   │
       │                                     │
       ▼                                     │
Network 404: v1 chunk no longer on server!   ▼
Fatal Runtime Error: ChunkLoadError 💥    (Worker activated with skipWaiting)
```
- If you call `skipWaiting()`, open tabs immediately start requesting `v2` chunks while running `v1` code, causing fatal runtime exceptions or 404 chunk failures.
- If you don't call `skipWaiting()`, updates remain stuck in `waiting` indefinitely because users rarely close all tabs.

### How NLPWA Solves It with Staged Delta Caches & Client Pinning
```
Tab 1 (Pinned to offline@v1)          Staging Subsystem (offline@v2)
       │                                     │
       ├─ Subresource request for /app.js    ├─ Downloads changed files in background
       │  Served from offline@v1             ├─ Verifies SHA-256 digests
       │  (100% consistent with running tab) └─ Staging complete! Ready to commit.
       │                                     │
       ├─────────────────────────────────────┴─ Tab navigates (or clicks Refresh)
       ▼                                        Atomic Pointer Flip (nlpwa-meta)
Tab 1 navigates → Pinned to offline@v2           Switched instantly with zero churn!
```

1. **The SW Engine Never Reinstalls:** The engine installs once and stays running. App updates arrive as JSON manifests.
2. **Per-Tab Version Pinning:** Every open window is pinned by `clientId` to its active offline cache (`offline@v1`). A newly committed update in another tab will never alter the assets of a running tab.
3. **Grace Period Protection:** New navigations enjoy a 30-second pin grace period during document loads so tabs are never prematurely unpinned before `clients.matchAll()` registers them.
4. **Atomic Pointer Flip:** Updating versions is a single atomic metadata write in `nlpwa-meta`. Once switched, the next navigation loads the new version seamlessly.

---

## Integrity: Operational Verification vs. Cryptographic Signatures

During update staging, each downloaded file is verified against its SHA-256 digest before being admitted into the staging cache:

### 1. Operational Integrity (Built-in Default)
- **What it protects against:**
  - **Network corruption and truncation:** Partial downloads over unstable cellular connections are detected and retried.
  - **Soft-404 / SPA fallbacks:** CDNs or single-page app hosts configured to return `index.html` with a `200 OK` when an asset is missing are caught before corrupting JavaScript bundles.
  - **Captive portals:** Hotel, airport, or public Wi-Fi networks intercepting asset requests with HTML login screens are blocked from overwriting application code.
  - **Partial multi-CDN deployments:** Updates are never committed if CDN propagation is delayed for any single file.

### 2. Cryptographic Tamper-Evidence (Built-in Ed25519 Signatures)
Because `sw.js` is byte-checked directly by the browser (bypassing HTTP caches on navigation), an **Ed25519 public key** configured in `nlpwa.config.js` or `sw.js` serves as an authenticated root of trust. Setting `publicKey` automatically elevates `verifyHashes` to `'strict'` and locks security-critical fields (`publicKey`, `updateAPI`, `telemetry`) from runtime config tampering.

Build pipelines sign both Tier 1 (`version.json`) and Tier 2 (`info.json`) manifests at build time using the developer's private key (`NLPWA_PRIVATE_KEY`):

```bash
# Generate an Ed25519 keypair and save private key to your local .env.nlpwa (0600)
npx nlpwa keys:generate
```

This yields end-to-end cryptographic tamper-evidence against compromised CDNs, rogue server writes, replay attacks, or man-in-the-middle attacks without requiring Subresource Integrity (SRI) on every HTML tag.

---

## Architecture at a Glance

### Storage Model

| Cache | Purpose |
|---|---|
| `offline@<version>-<id>` | One per app version: app shell (`precache`) + `/api/update/config.json` + internal snapshot `/_nlpwa/snapshot.json`. Only the **active** one serves requests. |
| `runtime` | Assets cached lazily on first request; evicted when stale. |
| `nlpwa-fallback` | Holds previous known-good version as an automatic safety rollback target during updates. |
| `nlpwa-meta` | Small JSON pointers: which `offline@…` cache is active, client version pins, minimum version, blocked versions, and whether a complete update is staged. |

### Two-Tier Update Flow

```
1. Client triggers check (on register + interval + tab focus + periodic sync)
2. Tier 1: GET /api/update/version.json → { version, minVersion, blockedVersions, channel, rolloutPercent }
3. Check blockedVersions & minVersion → unpin affected tabs and broadcast UPDATE_REQUIRED.
4. Evaluate cohort rolloutPercent & channel subscription → skip if client not in rollout.
5. Compare against live version → already up to date? STOP immediately.
6. Tier 2: GET /api/update/info.json → { version, files: [{path, hash}], signature }
7. Verify Ed25519 signature via crypto.subtle.verify() → abort if invalid.
8. Stage a new offline@<version>-<id> cache in background:
   - Check bandwidth budget (saveData, maxUpdateBytes, wifiOnlyThresholdBytes)
   - unchanged files (same hash as live) are copied locally (zero network bytes)
   - changed files are fetched (no-store) and verified against SHA-256 hashes
9. Write snapshot last (marks staged cache complete)
10. postMessage UPDATE_READY ({ version }) → client displays update prompt
11. On navigation or NLPWAClient.applyUpdate():
    atomically switch active pointer in nlpwa-meta, retain previous as nlpwa-fallback, reload config.
12. Boot Watchdog: Client calls nlpwa.markHealthy() within timeout, or SW auto-rolls back to fallback.
```

---

## Documentation Hub

Explore the complete topic reference guides:

| Document | Topic & Details |
|---|---|
| 📚 [**Documentation Portal**](docs/README.md) | Central documentation directory and complete topic index |
| 🌟 [**Features & Capabilities**](docs/FEATURES.md) | **Definitive reference:** Atomic OTA updates, client pinning, Ed25519 signing, rollback watchdog, staging budgets, and modular plugins |
| 📐 [**Architecture Guide**](docs/ARCHITECTURE.md) | System design, internal module map, client version pinning, and update state machine |
| ⚙️ [**Configuration Reference**](docs/config/README.md) | Full schema reference for `nlpwa.config.js`, global options, and routing rules |
| 💻 [**Client SDK & Runtime API**](docs/client/README.md) | `NLPWAClient` methods, options, DOM events, multi-tab coherence, state, and storage |
| 🛠️ [**CLI & Bundler Integration**](docs/CLI.md) | `nlpwa init/add/update/status/keys:generate`, Rollup & Vite plugins, and CI/CD pipelines |
| 🔌 [**Plugin Architecture & Ecosystem**](docs/plugins/README.md) | Plugin lifecycle hooks and guide to official plugins |
| 🔄 [**Background & Periodic Sync**](docs/plugins/SYNC.md) | Offline mutation queueing with FIFO replay, dead-letter store & periodic background sync |
| 🔔 [**Web Push Plugin**](docs/plugins/PUSH.md) | Web Push subscriptions, VAPID key conversion, and interactive action routing |
| 📥 [**Background Fetch Plugin**](docs/plugins/BG-FETCH.md) | Large file background downloads & uploads (>25MB) with IDB streaming |
| 📲 [**Web Share Target**](docs/plugins/SHARE.md) | Native OS share sheet listener and offline file hydration |
| 🏷️ [**OS App Badging**](docs/plugins/BADGE.md) | Application icon badge counters with push clearing |
| 🔐 [**Ed25519 Cryptographic Verification**](docs/plugins/CRYPTO.md) | Web Crypto detached signature utilities |
| 🚦 [**Fetch Strategies**](docs/STRATEGIES.md) | Caching behavior for `cache-first`, `network-first`, `stale-while-revalidate`, etc. |
| 📦 [**Update Protocol Spec**](docs/UPDATE-PROTOCOL.md) | Two-tier JSON manifests, SHA-256 hashing format, and atomic staging lifecycle |

---

## Development

```bash
# Install dependencies
npm install

# Build all bundles (SW, Client, Plugins, CLI)
npm run build

# Watch mode
npm run dev

# Run unit tests
npm test

# Run Playwright E2E tests
npm run test:e2e
```

### Build Outputs (`out/`)
- `out/sw.js` — Standalone Service Worker (copied by `nlpwa init`)
- `out/sw.module.js` — Service Worker library (`import { initSW } from 'nlpwa/sw'`)
- `out/client.js` — Client IIFE (`window.NLPWAClient`)
- `out/client.esm.js` — Client ES module (`import { register } from 'nlpwa/client'`)
- `out/api/update/config.json` — Runtime configuration starter
- `out/plugins/sync.js`, `sync.sw.js`, `sync.client.esm.js`, `sync.client.js` — Background Sync plugin
- `out/plugins/sync.periodic.js`, `sync.periodic.client.esm.js`, `sync.periodic.client.js` — Periodic Background Sync subpath
- `out/plugins/push.js`, `push.sw.js`, `push.client.esm.js`, `push.client.js` — Web Push plugin
- `out/plugins/bg-fetch.js`, `bg-fetch.sw.js`, `bg-fetch.client.esm.js`, `bg-fetch.client.js` — Background Fetch plugin (>25MB streaming)
- `out/plugins/share.js`, `share.sw.js`, `share.client.esm.js`, `share.client.js` — Web Share Target plugin
- `out/plugins/badge.js`, `badge.sw.js`, `badge.client.esm.js`, `badge.client.js` — App Badging API plugin
- `out/plugins/crypto.js` — Ed25519 signing & verification module
- `out/rollup-plugin.js` — Rollup/Vite plugin (`import nlpwa from 'nlpwa/vite'`)
- `out/webpack-plugin.js` — Webpack/Next.js/Rspack plugin (`import { NlpwaWebpackPlugin } from 'nlpwa/webpack'`)

---

## License

MIT
