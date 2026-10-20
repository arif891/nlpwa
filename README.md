# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, atomic over-the-air (OTA) delta updates, client version pinning, and background sync — all from three drop-in files (or npm package exports).

> [!NOTE]
> **Prototype Stage:** NLPWA is currently in prototype development and under active evolution. APIs, configuration options, and storage protocols may be refined as we head toward a stable 1.0 release. Feedback, issues, and contributions are very welcome!

---

## The Core Problem: Why Most PWAs Feel Fragile

In traditional Service Worker setups (like Workbox), every app update requires re-compiling the Service Worker script itself. When a user opens an app while an update is rolling out, one of two bad things happens:
1. **Version Drift / Broken Tabs:** The new Service Worker calls `skipWaiting()`, abruptly swapping cached assets out from underneath active tabs. The user clicks a route or dynamically imports a chunk, and gets a `404 ChunkLoadError` or loads mixed-version code.
2. **Infinite Waiting Workers:** The user is trapped on an obsolete version until *all* open tabs are closed simultaneously.

**NLPWA eliminates this completely through Atomic OTA Updates and Client Version Pinning.**

---

## Core Capabilities

- **Atomic Over-The-Air (OTA) Updates** — Updates stage into an isolated delta cache in the background. Only after 100% of files are downloaded and verified does the version atomically flip. You never get half-updated states.
- **Client Version Pinning (Zero Version Drift)** — Each open tab is pinned to the exact version it booted with. Subresource requests continue serving from that version until the tab navigates or the user confirms an update banner.
- **Decoupled SW vs. App Lifecycle** — The Service Worker engine installs once and stays running. App releases arrive as data-driven OTA deltas without worker re-registration churn.
- **Two-Tier Update Protocol** — A tiny Tier 1 check (~20 bytes) confirms if an update exists before downloading any file manifests, keeping network and battery overhead near zero.
- **Cryptographic Hash Verification** — Every staged file is validated against SHA-256 digests in transit, protecting against captive portal HTML intercepts, proxy glitches, and corrupted downloads.
- **Minimum Supported Version (`minVersion`)** — Breaking backend API change? Set `minVersion` on your server to automatically unpin deprecated versions and force a clean reload.

---

## NLPWA vs. Workbox

| Capability | Workbox | NLPWA |
|:---|:---:|:---:|
| **Update Architecture** | Re-installs entire Service Worker per release | Decoupled SW engine + background OTA delta protocol |
| **Open Tab Isolation** | ❌ None (`skipWaiting` breaks active tabs) | ✅ **Client Version Pinning** isolates each tab to its boot version |
| **Atomic Staging** | ❌ Live in-place cache mutation | ✅ **Isolated staging cache** with zero mixed-version states |
| **Asset Download Strategy** | Re-downloads revised precache assets | Downloads only diffs; copies unchanged files locally (0 bytes) |
| **Integrity Verification** | Custom revision string comparison | In-transit **SHA-256** checksum verification on all staged files |
| **Breaking Version Guard** | ❌ Requires custom messaging logic | ✅ Built-in **`minVersion`** auto-evicts outdated clients |
| **Deploy Workflow** | Must re-compile / re-inject `sw.js` every build | `sw.js` stays static; CLI emits lightweight JSON update manifests |
| **Dependencies** | Dozens of packages (`workbox-*`) | **Zero runtime dependencies** (drop-in pre-bundled files or npm exports) |
| **Native OS Integrations** | ❌ None (must hand-roll) | ✅ Built-in Install manager, Badging, Share Target, and Persistent Storage |

---

## Built-in Native OS Integrations

In addition to atomic updates, NLPWA provides zero-dependency native OS wrappers:
- **PWA Installation Manager** — Captures `beforeinstallprompt` automatically, persists deferred prompt across navigation, and exposes `nlpwa.install()`.
- **Persistent Storage** — `nlpwa.requestPersistentStorage()` guards offline caches from browser eviction under storage pressure.
- **Unified Reactive State Store** — `nlpwa.subscribe((state) => ...)` exposes unified status (`online`, `updateStatus`, `badgeCount`, `isInstallable`) for React, Vue, Svelte, or vanilla JS.
- **OS Badging API** — `nlpwa.setBadge()` / `nlpwa.clearBadge()` sets app icon badges across Windows, macOS, Android, and iOS, with automatic clearing on push clicks.
- **Web Share Target** — Intercepts system share sheet submissions (files, text, URLs) into a safe FIFO queue with size protection and `nlpwa.onShareTarget()`.
- **Background Sync** — Queue offline `POST`/`PUT`/`DELETE` mutations in IndexedDB with automatic replay, dead-letter storage, and session redirect protection.

## Quick Start

### 1. Initialize in Your Project

```bash
# Drop sw.js, client.js, and nlpwa.config.js into the current directory
npx nlpwa init

# Or target your public or build directory
npx nlpwa init --dir ./public
```

Your project directory now has the core drop-in files:
```
your-app/
├── sw.js            ← Service Worker engine (pre-built, drop-in)
├── client.js        ← Client runtime SDK (pre-built, drop-in)
├── nlpwa.config.js  ← Project configuration (app version, precache list, route strategies)
├── assets/
│   ├── other/
│   │   └── manifest.webmanifest ← W3C Web App Manifest (standalone, shortcuts, launch handler)
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

  verifyHashes: 'strict',

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

### 3. Register from Your HTML

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0ea5e9">
  <link rel="manifest" href="/assets/other/manifest.webmanifest">
  <link rel="icon" href="/assets/image/icon/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/assets/image/icon/icon-192.png">
  <script src="/client.js"></script>
</head>
<body>
  <div id="update-banner" hidden>
    A new version is available.
    <button onclick="NLPWAClient.applyUpdate()">Refresh</button>
  </div>

  <button id="install-btn" hidden onclick="NLPWAClient.nlpwa.install()">Install App</button>

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

In traditional Progressive Web Apps, application files and Service Worker scripts are tightly coupled. When you push an update:

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

## How NLPWA Compares with Workbox

[Workbox](https://developer.chrome.com/docs/workbox) is Google's modular, low-level toolkit for service worker caching and routing. NLPWA approaches PWAs from a different angle — as an integrated, application-centric framework designed specifically around native-like Over-The-Air (OTA) updates:

| Dimension | Workbox | NLPWA |
|---|---|---|
| **Architectural Model** | **Modular Toolkit.** A collection of libraries (`workbox-routing`, `workbox-precaching`, `workbox-strategies`) for assembling custom service workers. | **Integrated App Framework.** A pre-bundled engine, runtime SDK, and build tool designed specifically for atomic Over-The-Air app releases. |
| **App Updates & Lifecycle** | **Worker Lifecycle Bound.** Updating precached files changes `sw.js` bytes, triggering the browser's worker update cycle (`install` → `waiting` → `activate`). | **Decoupled Engine & App.** The SW engine remains active; application updates arrive Over-The-Air via lightweight JSON manifests (`version.json` / `info.json`). |
| **Multi-Tab Consistency** | **Coordinated via `skipWaiting()`.** Managing multi-tab version coherence requires manual window communication or user prompt coordination. | **Built-in Client Pinning.** Every open tab is isolated by `clientId` to its active cache. Existing tabs never switch assets mid-session. |
| **Delta Downloads** | **Revision-based Precache.** Downloads modified assets during worker installation; unchanged files are retained in the precache store. | **Local Hash Diffing.** Unchanged files are copied locally from the active cache (zero network bytes); changed files are staged and SHA-256 verified in an isolated cache. |
| **Integrity & Safety** | **Optional SRI.** Supports Subresource Integrity (`integrity` option) when configured during build. | **Built-in Manifest Verification.** Automatically verifies staged assets against SHA-256 hashes to block soft-404s, captive portals, and truncated downloads. |
| **API Deprecation Safety** | **Custom Logic.** Requires developer-implemented version guards or server-side version negotiation. | **`minVersion` Guard.** Built-in minimum supported version enforcement that unpins outdated tabs and prompts/forces reloads. |

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

## Integrity: Operational Verification vs. Cryptographic Signatures

During update staging, each downloaded file is verified against its SHA-256 digest before being admitted into the staging cache. It is useful to distinguish the two security and reliability boundaries:

### 1. Operational Integrity (Built-in Default)
- **What it protects against:**
  - **Network corruption and truncation:** Partial downloads over unstable cellular connections are detected and retried.
  - **Soft-404 / SPA fallbacks:** CDNs or single-page app hosts configured to return `index.html` with a `200 OK` when an asset is missing are caught before corrupting JavaScript bundles.
  - **Captive portals:** Hotel, airport, or public Wi-Fi networks intercepting asset requests with HTML login screens are blocked from overwriting application code.
  - **Partial multi-CDN deployments:** Updates are never committed if CDN propagation is delayed for any single file.
- **What it does not protect against:** An adversary with write access to your origin server or CDN credentials can overwrite both the assets and `info.json`.

### 2. Cryptographic Tamper-Evidence (Ed25519 Detached Signatures Roadmap)
Because `sw.js` is byte-checked directly by the browser (bypassing HTTP caches on navigation), an **Ed25519 public key** embedded into `sw.js` can serve as an authenticated root of trust. Build pipelines sign `info.json` with a private key, and the SW verifies the detached signature using the Web Crypto API (`crypto.subtle.verify`) before staging an update. This yields end-to-end cryptographic tamper-evidence against compromised CDNs or man-in-the-middle attacks without requiring Subresource Integrity (SRI) on every HTML tag.

---

## Architecture at a Glance

### Storage Model

| Cache | Purpose |
|---|---|
| `offline@<version>-<id>` | One per app version: app shell (`precache`) + `/api/update/config.json` + internal snapshot `/_nlpwa/snapshot.json`. Only the **active** one serves requests. |
| `runtime` | Assets cached lazily on first request; evicted when stale. |
| `nlpwa-meta` | Small JSON pointers: which `offline@…` cache is active, client version pins, minimum version, and whether a complete update is staged. |

### Two-Tier Update Flow

```
1. Client triggers check (on register + interval + tab focus + periodic sync)
2. Tier 1: GET /api/update/version.json → { version, minVersion }
3. Check minVersion → unpin deprecated tabs and broadcast UPDATE_REQUIRED if needed.
4. Compare against live version → already up to date? STOP immediately.
5. Tier 2: GET /api/update/info.json → { version, files: [{path, hash}] }
6. Stage a new offline@<version>-<id> cache in background:
   - unchanged files (same hash as live) are copied locally (zero network bytes)
   - changed files are fetched (no-store) and verified against SHA-256 hashes
7. Write snapshot last (marks staged cache complete)
8. postMessage UPDATE_READY ({ version }) → client displays update prompt
9. On navigation or NLPWAClient.applyUpdate():
   atomically switch active pointer in nlpwa-meta, reload config, evict runtime
```

---

## Documentation Hub

Explore the complete documentation in the [`docs/`](docs/) directory:

| Document | Topic & Details |
|---|---|
| 📐 [**Architecture Guide**](docs/ARCHITECTURE.md) | System design, internal module map, client version pinning, and update state machine |
| ⚙️ [**Configuration Reference**](docs/CONFIG.md) | Full schema reference for `nlpwa.config.js` and runtime options |
| 💻 [**Client SDK & Runtime API**](docs/CLIENT-API.md) | `NLPWAClient` methods, options, DOM events, multi-tab coherence, and storage quota cleanup |
| 🛠️ [**CLI & Bundler Integration**](docs/CLI.md) | `nlpwa init/add/update/status`, Rollup & Vite plugins, and CI/CD pipelines |
| 🔌 [**Plugins & Background Sync**](docs/PLUGINS.md) | Plugin lifecycle hooks and official `nlpwa/sync` offline mutation queue |
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
- `out/plugins/sync.js` — Background Sync plugin ES module (`import { initSync } from 'nlpwa/sync'`)
- `out/plugins/sync.client.esm.js` — Background Sync Client ES module (`import { initSyncClient } from 'nlpwa/sync/client'`)
- `out/plugins/sync.sw.js` — Standalone Background Sync SW plugin
- `out/plugins/sync.client.js` — Standalone Background Sync Client SDK
- `out/rollup-plugin.js` — Rollup/Vite plugin (`import nlpwa from 'nlpwa/vite'`)
- `out/webpack-plugin.js` — Webpack/Next.js/Rspack plugin (`import { NlpwaWebpackPlugin } from 'nlpwa/webpack'`)

---

## License

MIT
