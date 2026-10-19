# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, atomic over-the-air (OTA) delta updates, and background sync — all from three drop-in files (or npm package exports).

> [!NOTE]
> **Prototype Stage:** NLPWA is currently in prototype development and under active evolution. APIs, configuration options, and storage protocols may be refined as we head toward a stable 1.0 release. Feedback, issues, and contributions are very welcome!

---

## Features

- **Decoupled SW vs. App versioning** — SW engine version is managed manually; App version is deterministically derived from manifest content hashes (or semver)
- **Dynamic runtime configuration** — write routes in `config.js`; SW reads from `offline` cache for instant updates without SW reinstall
- **Only offline files tracked** — build tool tracks & hashes only `config.json` and precached app shell files
- **Two-tier update check** — lightweight version check first (~20 bytes); full manifest only downloaded when an update exists
- **5 fetch strategies** per URL pattern with glob routing and response fidelity
- **Hash-based OTA delta updates** — only changed files are re-fetched, and every download is verified against SHA-256 manifest hashes
- **Atomic updates & Client Version Pinning** — new versions stage in an isolated cache; open tabs remain pinned to their active version; updates swap with a single pointer write
- **Multi-tab coherence & form-edit protection** — open tabs sync cleanly, while automatic reloads are safely deferred if the user is typing in forms
- **Offline mutation & Background Sync** — queue offline `POST`/`PUT`/`DELETE` in IndexedDB and replay with automatic cross-browser fallbacks
- **Zero runtime dependencies** — pre-bundled standalone engine (`sw.js`), runtime SDK (`client.js`), and starter config

---

## Why "Native-like"?

Native mobile apps (iOS & Android) feel reliable because they follow a strict, atomic update lifecycle:
1. **Background Staging:** Updates download quietly over the air (OTA) in the background without interrupting the active screen or dropping unsaved user work.
2. **Atomic Version Swapping & Client Version Pinning:** When the user restarts or navigates, the app switches versions as a single atomic unit. With per-client version pinning via `clientId`, an existing tab running unhashed code is isolated to its pinned version cache for its entire lifecycle—even if another tab navigates and commits a newer version. Pinned version caches are protected from garbage collection while tabs remain open.
3. **Delta Syncing:** Only files that actually changed are transferred over the wire.
4. **Integrity Verification:** Every downloaded file is verified with SHA-256 hashes against the manifest before it is allowed to go live. (Protects against network transport corruption, captive portal intercepts returning 200 HTML for missing assets, and partial deployments).

Standard Service Worker setups often fail this test: calling `self.skipWaiting()` either causes abrupt mid-session reloads or leaves active tabs serving half-v1 and half-v2 assets. **NLPWA reproduces the native mobile app update lifecycle on the web.**

---

## How NLPWA Compares with Workbox

[Workbox](https://developer.chrome.com/docs/workbox) is Google's modular, low-level library for service worker routing and caching. NLPWA approaches PWAs from a different angle — as an integrated, app-centric framework with native-like over-the-air (OTA) updates:

| Dimension | Workbox | NLPWA |
|---|---|---|
| **SW vs. App Versioning** | **Tightly Coupled.** Precache manifests are typically injected into `sw.js` (`self.__WB_MANIFEST`). Changing any application file changes `sw.js` bytes, triggering the browser's full Service Worker lifecycle (`install` → `waiting` → `activate`). | **Decoupled Engine & App.** The SW engine remains active across app updates. App updates arrive over the air via lightweight JSON manifests (`version.json` / `info.json`), staging updates in the background without worker lifecycle churn. |
| **Staging & Cache Turnover** | **Worker Lifecycle Driven.** New assets are cached during the waiting worker's `install` event; switching versions requires coordinating `skipWaiting()` and client window reloads. | **Isolated Atomic Swap.** Updates stage into an isolated cache (`offline@v2`) in the background while the active app runs undisturbed. Versions swap cleanly on navigation (or on prompt) via an atomic pointer flip (`nlpwa-meta`). |
| **Download Integrity & Soft-404s** | **Optional SRI.** Supports Subresource Integrity (`integrity` option), but requires developers to configure and generate integrity hashes during build. | **Built-in Manifest Verification.** Automatically hashes and verifies every staged asset against SHA-256 digests. Built-in protection against captive portals or SPA hosts serving 200 HTML for missing assets. |
| **Update Delivery & Frequency** | **Browser Script Checks.** Driven primarily by browser byte-checks on `sw.js` (on navigation or 24-hour intervals) or manual `registration.update()` calls. | **Two-Tier App Protocol.** In addition to browser SW checks, client apps can check for app updates on tab focus, interval, or custom UI via a lightweight Tier 1 JSON check before fetching full manifests. |
| **Integration & Batteries** | **Modular Toolkit.** Gives you low-level building blocks, but requires writing worker glue code, build integrations, postMessage channels, and custom reload UI prompts. | **Turnkey App Framework.** Pre-bundled SW engine, CLI (`nlpwa init` / `nlpwa update` / `nlpwa add`), Rollup/Vite plugins, cross-tab update coordination, form-edit protection prompts, and quota management out of the box. |

### When Workbox is the Better Choice

While NLPWA provides a turnkey application framework with atomic OTA updates, full plugin lifecycle hooks, and background sync, Workbox remains the industry standard when you need:
- **Custom Service Worker Architecture**: Writing bespoke worker routing pipelines, stream transformations, or assembling custom worker topologies with low-level primitives.
- **Broad Framework Ecosystem**: Deep, off-the-shelf integrations with Next.js PWA plugins (`next-pwa` / `@ducanh2912/next-pwa`), Nuxt PWA, or legacy Webpack build chains (`workbox-webpack-plugin`).
- **Google Analytics Offline Queueing**: Specialized, pre-bundled tracking queueing for Google Analytics (`workbox-google-analytics`).
- **Per-Route Runtime Expiration Rules**: Configuring max-age and max-entries declaratively inside individual route declarations without coordinating explicit cache cleanup calls (`workbox-expiration`).

---

## File Roles: What Do I Edit vs. What Do I Copy / Generate?

| File | Type | Do I edit it? | Role & Description |
|---|---|---|---|
| **`config.js`** *(or `nlpwa.config.js`)* | Source | ✏️ **Yes — Edit this** | Your primary configuration. Define your app version, precached shell files, and route strategies. |
| **`sw.js`** | Core Engine | 📋 **Copy / Drop-in** | The pre-bundled Service Worker engine. Copied into your project by `nlpwa init` (or imported via `nlpwa/sw`). |
| **`client.js`** | Client SDK | 📋 **Copy / Drop-in** | The client runtime script. Exposes `window.NLPWAClient` / `register()`, handles update prompts, and provides cache management. |
| **`config.json`** | Runtime Data | ⚙️ **Generated / Deployed** | Emitted automatically into your build directory (`dist/`) by `nlpwa update` from `config.js` and loaded into the offline cache. |
| **`api/update/*`** | Manifests | ⚙️ **Generated / Deployed** | Generated by `nlpwa update` (`version.json` and `info.json`). These are the static HTTP endpoints your Service Worker polls for OTA delta updates. |

---

## Quick Start

### 1. Initialize in Your Project

```bash
# Drop sw.js, client.js, and config.json into current directory
npx nlpwa init

# Or target a public/build directory
npx nlpwa init --dir ./public
```

Your project directory now has the three core drop-in files:
```
your-app/
├── sw.js         ← Service Worker engine (pre-built, drop-in)
├── client.js     ← Client runtime SDK (pre-built, drop-in)
├── config.json   ← Runtime configuration (edit directly or generate from config.js)
└── index.html
```

### 2. Configure Your App in `config.js`

```javascript
// config.js
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
    '/app.js',
    '/styles.css',
    '/icon-192.png',
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

### 3. Register from your HTML

```html
<!-- In index.html, before closing </body> -->
<script src="/client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version }) => {
      document.getElementById('update-banner').hidden = false;
    },
  });
</script>

<div id="update-banner" hidden>
  A new version is available.
  <button onclick="NLPWAClient.applyUpdate()">Refresh</button>
</div>
```

*(Using a bundler? Import `import { register, applyUpdate } from 'nlpwa/client'` instead).*

### 4. Build and Hash with CLI

```bash
# Computes deterministic content hash (e.g. 1.0.0-a1b2c3d4e5f6) and outputs to ./dist
npx nlpwa update --dir ./dist
```

This generates:
- `dist/config.json` (runtime config for the SW offline cache)
- `dist/api/update/version.json` (`{ "version": "1.0.0-a1b2c3d4e5f6" }`)
- `dist/api/update/info.json` (`{ "version": "1.0.0-a1b2c3d4e5f6", "files": [...] }`)

---

## Architecture at a Glance

### Storage Model

| Cache | Purpose |
|---|---|
| `offline@<version>-<id>` | One per app version: app shell (`precache`) + `config.json` + internal snapshot `/_nlpwa/snapshot.json`. Only the **active** one serves requests. |
| `runtime` | Assets cached lazily on first request; evicted when stale. |
| `nlpwa-meta` | Two tiny pointers: which `offline@…` cache is active, and whether a complete update is staged. |

### Two-Tier Update Flow

```
1. Client triggers check (on register + every interval + tab focus + periodic sync)
2. Tier 1: GET /api/update/version.json → { version }
3. Compare against the live version → already up to date? STOP immediately.
4. Tier 2: GET /api/update/info.json → { version, files: [{path, hash}] }
5. Stage a new offline@<version>-<id> cache in background:
   - unchanged files (same hash as live) are copied locally (zero network)
   - changed files are fetched (no-store) and verified against SHA-256 hashes
6. Write snapshot last (marks staged cache complete)
7. postMessage UPDATE_READY ({ version }) → client displays update prompt
8. On navigation or NLPWAClient.applyUpdate():
   atomically switch active pointer in nlpwa-meta, reload config, evict runtime
```

---

## Documentation Hub

Explore the complete documentation in the [`docs/`](docs/) directory:

| Document | Topic & Details |
|---|---|
| 📐 [**Architecture Guide**](docs/ARCHITECTURE.md) | System design, internal module map, client version pinning, and update state machine |
| ⚙️ [**Configuration Reference**](docs/CONFIG.md) | Full schema reference for `config.js` and runtime options |
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
- `out/config.json` — Runtime configuration starter
- `out/plugins/sync.sw.js` — Standalone Background Sync SW plugin
- `out/plugins/sync.client.js` — Standalone Background Sync Client SDK
- `out/rollup-plugin.js` — Rollup/Vite plugin (`import nlpwa from 'nlpwa/vite'`)

---

## License

MIT
