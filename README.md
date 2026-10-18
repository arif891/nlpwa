# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, and seamless OTA (over-the-air) delta updates — all from three drop-in files (or npm package exports).

> [!NOTE]
> **Prototype Stage:** NLPWA is currently in prototype development and under active evolution. APIs, configuration options, and storage protocols may be refined as we head toward a stable 1.0 release. Feedback, issues, and contributions are very welcome!

---

## Features

- **Decoupled SW vs. App versioning** — SW engine version is managed manually; App version is deterministically derived from manifest content hashes (or semver)
- **Dynamic runtime configuration** — write routes in `config.js`; SW reads from `offline` cache for instant updates without SW reinstall
- **Only offline files tracked** — build tool tracks & hashes only `config.json` and precached app shell files
- **Two-tier update check** — lightweight version check first (~20 bytes); full manifest only downloaded when an update exists
- **5 fetch strategies** per URL pattern (glob routing)
- **Hash-based OTA delta updates** — only changed files are re-fetched, and every download is verified against its manifest hash
- **Atomic updates** — new versions are staged in a separate cache and switched in with one pointer write; a failed or interrupted update never affects the running app
- **Route-aware cache eviction** — stale entries removed automatically on route change
- **Self-healing cache** — failed fetches retry on next update check
- **Three drop-in files** — `sw.js` (core engine), `config.json` (routes/settings), and `client.js` (runtime SDK)

---

## Why "Native-like"?

Native mobile apps (iOS & Android) feel reliable because they follow a strict, atomic update lifecycle:
1. **Background Staging:** Updates download quietly over the air (OTA) in the background without interrupting the active screen or dropping unsaved user work.
2. **Atomic Version Swapping:** When the user restarts or navigates, the app switches versions as a single atomic unit. You are never left in a broken "Frankenstein" state where new HTML requests old JavaScript chunks that have vanished from the server (the notorious PWA chunk mismatch 404).
3. **Delta Syncing:** Only files that actually changed are transferred over the wire.
4. **Integrity Verification:** Every downloaded file is verified with SHA-256 hashes against the manifest before it is allowed to go live. (Because manifest hashes are served from the same origin, this protects against network transport corruption, captive portal intercepts returning 200 HTML for missing assets, and partial deployments—not against a compromised web server).

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
| **Integration & Batteries** | **Modular Toolkit.** Gives you low-level building blocks, but requires writing worker glue code, build integrations, postMessage channels, and custom reload UI prompts. | **Turnkey App Framework.** Pre-bundled SW engine, CLI (`nlpwa init` / `nlpwa update`), Rollup/Vite plugins, cross-tab update coordination, form-edit protection prompts, and quota management out of the box. |

---

## File Roles: What Do I Edit vs. What Do I Copy / Generate?

To prevent confusion between source files, drop-in engines, and generated build outputs:

| File | Type | Do I edit it? | Role & Description |
|---|---|---|---|
| **`config.js`** *(or `nlpwa.config.js`)* | Source | ✏️ **Yes — Edit this** | Your primary configuration. Define your app version, precached shell files, and route strategies with JavaScript comments and types. |
| **`sw.js`** | Core Engine | 📋 **Copy / Drop-in** | The pre-bundled Service Worker engine. Copied into your project by `nlpwa init` (or imported via `nlpwa/sw`). Do not edit unless customizing core SW hooks. |
| **`client.js`** | Client SDK | 📋 **Copy / Drop-in** | The client runtime script. Exposes `window.NLPWAClient` / `register()`, handles update prompts, and provides cache management. |
| **`config.json`** | Runtime Data | ⚙️ **Generated / Deployed** | Emitted automatically into your build directory (`dist/`) by `nlpwa update` from `config.js` and loaded into the offline cache. *(In pure no-build static projects, you can edit this directly instead of `config.js`)*. |
| **`api/update/*`** | Manifests | ⚙️ **Generated / Deployed** | Generated by `nlpwa update` (`version.json` and `info.json`). These are the static HTTP endpoints your Service Worker polls for OTA delta updates. |

---

## Quick Start

### 1. Initialize in Your Project

You can drop NLPWA into any project with a single command:

```bash
# Drop sw.js, client.js, and config.json into current directory
npx nlpwa init

# Or target a public directory
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

Developers edit `config.js` directly:

```js
export default {
  // Base app version (prefixed to content-derived version: <version>-<12-char hash>)
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },

  // Verify SHA-256 hashes against update manifest ('strict' | 'warn' | false)
  verifyHashes: 'strict',

  // App shell files to track and offline-cache
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
    '/assets/icons/icon-192.png',
  ],

  // Per-route fetch strategies (evaluated top-to-bottom)
  routes: [
    { match: '/api/**',       strategy: 'network-only'           },
    { match: '/assets/**',    strategy: 'cache-first'            },
    // Cross-origin CDN assets (e.g. wasm, AI models, libraries)
    { match: 'https://cdn.jsdelivr.net/npm/**', strategy: 'cache-first' },
    { match: '/pages/**',     strategy: 'network-first', networkTimeoutMs: 3000 },
    { match: '/_feeds/**',    strategy: 'stale-while-revalidate' },
  ],
  // Fallback strategy for unmatched dynamic requests
  defaultStrategy: 'network-first',
};
```

> [!TIP]
> **Keep `precache` limited to the essential app shell**: During update staging, `fetchVerified` clones and buffers each downloaded resource in memory as an `ArrayBuffer` to verify its SHA-256 hash before storing it in `CacheStorage`. For core app shell assets (HTML, JS, CSS, icons), this is fast and lightweight. Avoid putting large multi-megabyte files (videos, heavy 3D assets or datasets) in `precache` as hashing will temporarily double peak memory usage; cache large assets via runtime routing strategies instead.

> [!NOTE]
> **Built-In Shell Atomicity Rule**: All precached and manifest files (your HTML shell, JS bundles, CSS, and icons) are **automatically served cache-first from the active offline cache** via a built-in, non-overridable routing rule. Even if your route config includes broad dynamic rules (e.g. `defaultStrategy: 'network-first'`), the app shell is never fetched raw from the network while an update is being staged. This guarantees that running tabs never serve mixed old/new files and that updates commit atomically.

### 3. Initialize the Service Worker (`sw.js`)

When you run `npx nlpwa init`, the generated `sw.js` is **already the standalone, bundled engine** ready to run out of the box — no custom build step required.

If you are customizing `sw.js` with a bundler (Vite or Rollup), you can import the engine directly:

```js
import { initSW } from 'nlpwa/sw';

initSW({
  // SW engine version (managed manually by dev)
  version: '1',
  // Path to runtime config (always read from and stored in offline cache)
  configPath: '/config.json',
  // Where the update API lives. The first install runs before config.json is
  // cached, so the engine needs these up front (match your config.js).
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },
});
```

### 4. Build and Update with CLI

Run the build tool to derive the content-hash app version, compile `config.js` into `config.json`, hash offline files, and emit the update API endpoints:

```bash
# Computes deterministic content hash (e.g. 1.0.0-a1b2c3d4e5f6) and outputs to ./dist
npx nlpwa update --dir ./dist
```

This generates:
- `dist/config.json` (runtime config for the SW offline cache)
- `dist/api/update/version.json` (`{ "version": "1.0.0-a1b2c3d4e5f6" }`)
- `dist/api/update/info.json` (`{ "version": "1.0.0-a1b2c3d4e5f6", "files": [...] }`)

**Key Versioning Properties:**
- **Deterministic & Idempotent**: Rebuilding identical code yields the exact same version string. CI pipelines and dev rebuilds will never prompt users with spurious "update ready" banners.
- **Rollback Friendly**: Reverting code restores the previous version string, allowing clients to roll back cleanly.
- **Clean Git Trees**: Source `config.js` is **never mutated** on build, avoiding noisy git diffs and bundler watch loops.

*(Note: If custom endpoint paths do not end with `.json`, e.g. `/api/update/version`, the CLI automatically generates directory `index.json` files).*

Manifest hashes are the first 32 hex characters of each file's SHA-256 digest.

#### CLI Reference

| Command / Flag | Default | Description |
|---|---|---|
| `npx nlpwa init [--dir <path>]` | `./` | Copies `sw.js`, `client.js`, and `config.json` to target directory |
| `npx nlpwa update [--dir <path>]` | `./dist` or `./` | Derives version from manifest content hash, builds `config.json`, hashes offline files, and emits update API |
| `--config <path>` | auto-detect | Path to custom config file (e.g. `./src/config.js`) |
| `--version <string>` | hash-derived | Explicit version override (e.g. `2.0.0`) |
| `--bump-patch` | `false` | Explicitly increment semver patch version (`1.0.0` → `1.0.1`) instead of content hash |
| `--sync-source` | `false` | Write updated version back into source `config.js` file (opt-in) |
| `--pretty` | `false` | Pretty-print output JSON files with 2-space indentation (compact by default) |

### 5. Bundler Integration (Vite / Rollup)

If you use Vite or Rollup, you can automate updates on every build using the bundled plugin:

```js
// vite.config.js
import { defineConfig } from 'vite';
import nlpwa from 'nlpwa/vite'; // or 'nlpwa/rollup' for Rollup

export default defineConfig({
  plugins: [
    nlpwa({
      config: './src/config.js', // path to config file
      distDir: './dist',         // build output directory
      pretty: true,
    }),
  ],
});
```

### 6. Register from your HTML

```html
<!-- In index.html, before closing </body> -->
<!-- client.js is a classic script that defines the global `NLPWAClient` -->
<script src="/client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version, partial }) => {
      document.getElementById('update-banner').hidden = false;
    },
  });
</script>

<!-- Example update banner -->
<div id="update-banner" hidden>
  A new version is available.
  <button onclick="NLPWAClient.applyUpdate()">Refresh</button>
</div>
```

Using a bundler instead? Import the ES module build:

```js
import { register, applyUpdate } from 'nlpwa/client';
```

---

## Cache Storage

NLPWA uses these caches:

| Cache | Purpose |
| --- | --- |
| `offline@<version>-<id>` | One per app version: app shell (`precache`) + `config.json` + internal snapshot `/_nlpwa/snapshot.json`. Only the **active** one serves requests |
| `runtime` | Assets cached lazily on first request; evicted when stale |
| `nlpwa-meta` | Two tiny pointers: which `offline@…` cache is active, and whether a complete update is staged |

An update is built in a brand-new `offline@…` cache while the active one keeps serving. A cache that contains its snapshot is complete, and going live is a single write to the active pointer, so the app is always on either the old or the new version, never a mix. `config.json` lives inside the versioned cache, so routes switch together with the files they describe. An app installed by an older NLPWA (plain `offline` cache) is migrated on its first update.

---

## Two-Tier Update Flow

```
1. SW active → triggers check (on activate + every interval + tab focus)
2. Tier 1: GET /api/update/version.json → { version }
3. Compare against the live version → already up to date? STOP immediately.
4. Tier 2: GET /api/update/info.json → { version, files: [{path, hash}] }
5. Stage a new offline@<version>-<id> cache (the running app is not touched):
   - unchanged files (same hash as live) are copied locally, no network
   - added/modified files are fetched (no-store) and their SHA-256 is
     checked against the manifest (config.verifyHashes)
   - files that verified earlier are reused when a failed update is retried
6. Write the snapshot last (marks the staged cache complete)
7. postMessage UPDATE_READY ({ version, partial }) → client shows update prompt
8. On the next page navigation (or NLPWAClient.applyUpdate()):
   switch the active pointer in nlpwa-meta, reload config.json, evict changed
   entries from runtime cache, route-aware eviction, delete old offline cache
```

First install runs the same pipeline during `install` and switches at once (no prompt), so the first update check has nothing left to download. If any file fails to download or verify, the update is never finalized or committed (strict all-or-nothing atomicity); verified files are preserved in staging so subsequent checks resume, entering exponential backoff after 5 attempts while the active app version remains 100% clean and untouched.

---

## API Reference

### Service Worker: `initSW(config)`

See [docs/CONFIG.md](docs/CONFIG.md) for full config reference.

### Client: `NLPWAClient.register(swUrl, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `onUpdateReady` | `Function` | — | Called with `{ version, partial }` when update is staged |
| `onNoUpdate` | `Function` | — | Called with `{ version }` when app is confirmed up to date |
| `onUpdateApplied` | `Function` | — | Called with `{ version }` when update is committed across any tab |
| `onUpdatePrompt` | `Function` | — | Called when auto-reload is deferred because user is editing inputs |
| `autoReload` | `boolean` | `false` | Automatically apply update and reload when staged (deferred to prompt if editing inputs) |
| `reloadOnUpdateApplied` | `boolean` | `false` | Automatically reload this tab if another tab commits an update (deferred to prompt if editing) |
| `checkOnFocus` | `boolean` | `true` | Check for update when tab gains focus |
| `focusThrottleMs` | `number` | `3600000` | Min ms between focus-triggered checks (1 hr) |
| `pollIntervalMs` | `number` | `3600000` | Client interval (ms) to check updates while tab is active (1 hr) |

### Client: `NLPWAClient.applyUpdate(options)`

Asks the SW to switch to the staged update via `APPLY_UPDATE` message, waits for `UPDATE_APPLIED` confirmation (default timeout: 3000ms), and then reloads the page.

Options:
- `timeoutMs` (`number`, default: `3000`): Max wait for SW confirmation before forcing reload.
- `reload` (`boolean`, default: `true`): Set to `false` in SPAs if you want to commit the staged cache in the SW without triggering a full browser window reload.

---

## Multi-Tab Coherence & Single-Page Applications (SPAs)

Standard PWAs struggle with two common lifecycle challenges:
1. **The Multi-Tab Chunk 404 Problem:** Tab 1 reloads to version 2. Tab 2 stays open running version 1 JS. When Tab 2 attempts a dynamic `import('./lazy-chunk-v1.js')`, the old chunk is gone, crashing Tab 2.
2. **The SPA Navigation Dilemma:** In client-side routed SPAs (React Router, Vue Router, SvelteKit, etc.), route changes use `history.pushState` rather than browser document navigations. As a result, the SW never sees a `mode: 'navigate'` request, so staged updates never commit during in-app navigation unless coordinated.

NLPWA solves both cleanly:

### 1. Protect Open Tabs with `retainPreviousVersionCache`
Enable in `config.js`:
```js
// config.js
export default {
  retainPreviousVersionCache: true, // keeps immediate prior version's cache in storage
};
```
When enabled, the SW preserves the immediate prior offline cache (`v(N-1)`).

> [!NOTE]
> **How Cache Retention Works & Why Hashed Filenames Matter:**
> - `getFromOffline` only consults the retained previous cache on a **cache miss** in the active cache.
> - If an asset uses an **unhashed filename** (e.g., `/app.js`), it hits in the active cache, so open tabs will receive the new version.
> - When your bundler (Vite, Rollup, Webpack) emits **content-hashed dynamic chunks** (e.g., `/assets/chunk-[hash].js`), an older chunk requested by an open tab (`import('./chunk-v1.js')`) misses in the new active cache, safely falls back to the retained cache, and succeeds without throwing a 404.
> - Retention keeps one previous generation (`v(N-1)`). After two consecutive updates, the oldest cache is purged. Using content-hashed filenames for dynamic imports is therefore the true, permanent fix for chunk 404s.

### 2. Auto-Reload Background Tabs on Switch
Enable `reloadOnUpdateApplied: true` (or `autoReload: true`):
```js
NLPWAClient.register('/sw.js', {
  reloadOnUpdateApplied: true, // reloads this tab when another tab updates
});
```
When Tab 1 commits an update, the SW broadcasts `UPDATE_APPLIED` to all windows. Open tabs automatically reload. If the user is actively typing in a form input, textarea, or contentEditable element, **the reload is safely suppressed and an update prompt is offered instead** (`onUpdatePrompt` / `nlpwa:update-prompt` event) so unsaved form edits are never discarded.

### 3. SPA Router Integration
In an SPA, you can apply updates smoothly during in-app page transitions:

```js
// Example: Vue Router, React Router, or SvelteKit navigation hook
let hasStagedUpdate = false;

document.addEventListener('nlpwa:update-ready', () => {
  hasStagedUpdate = true;
});

// On route change:
router.beforeEach(async (to, from) => {
  if (hasStagedUpdate) {
    // Option A: Full reload to boot new bundle cleanly on route change
    NLPWAClient.applyUpdate();
    return false;

    // Option B: Atomically swap cache without full reload (if new routes are backwards-compatible)
    // await NLPWAClient.applyUpdate({ reload: false });
    // hasStagedUpdate = false;
  }
});
```

---

### Client Events

```js
// Fired when an update is staged and ready to apply
document.addEventListener('nlpwa:update-ready', (e) => {
  console.log('New version:', e.detail.version, 'Partial:', e.detail.partial);
});

// Fired when the app is confirmed up to date
document.addEventListener('nlpwa:no-update', (e) => {
  console.log('Already on latest version:', e.detail.version);
});

// Fired when an update switch has been committed (in this tab or another tab)
document.addEventListener('nlpwa:update-applied', (e) => {
  console.log('Update switched to active version:', e.detail.version);
});
```

### Manual update check (from client JS)

```js
// Trigger a check via the client library:
import { requestUpdateCheck } from 'nlpwa/client';
requestUpdateCheck();

// Or raw postMessage:
const reg = await navigator.serviceWorker.ready;
(navigator.serviceWorker.controller || reg.active)?.postMessage({ type: 'CHECK_UPDATE' });
```

### Storage Quota & Cache Cleanup (`getCacheInfo`, `cleanupRuntimeCache`)

Inspect storage quota and clean the runtime cache on demand from your web app:

```js
import { getCacheInfo, cleanupRuntimeCache } from 'nlpwa/client';
// or window.NLPWAClient.getCacheInfo()

// 1. Query browser storage quota and runtime cache metrics
const info = await getCacheInfo();
console.log(`Storage: ${info.percentUsed}% used (${(info.usage / 1024 / 1024).toFixed(1)} MB of ${(info.quota / 1024 / 1024).toFixed(1)} MB)`);
console.log(`Runtime cache: ${info.runtimeEntries} items (${(info.runtimeBytes / 1024).toFixed(1)} KB)`);
console.log('Top largest files:', info.largestEntries);

// 2. Clean runtime cache by largest size (to free disk space quickly)
await cleanupRuntimeCache({
  strategy: 'largest',
  maxTotalMB: 50, // keep total runtime cache under 50 MB (or maxTotalBytes: 50 * 1024 * 1024)
});

// Or evict any individual file larger than 5 MB:
await cleanupRuntimeCache({
  maxItemMB: 5, // or maxItemKB: 500, maxItemBytes: 5242880, or maxItem: '5MB'
});

// Or evict by quota threshold (keeps storage under 75%):
await cleanupRuntimeCache({
  strategy: 'quota',
  maxQuotaPercent: 75,
});

// Or LRU (oldest first):
await cleanupRuntimeCache({
  strategy: 'lru',
  maxEntries: 100,
});
```

#### Cleanup Strategies

All size options conveniently accept **MB** (`maxTotalMB`), **KB** (`maxTotalKB`), **Bytes** (`maxTotalBytes`), or string with units (e.g. `'50MB'`, `'500KB'`):

| Strategy | Key Options | Behavior |
|---|---|---|
| `'largest'` | `maxTotalMB` / `maxTotalKB` / `maxTotalBytes`, `maxEntries`, `minItemMB` | Sorts runtime files by size descending, evicting the largest files first |
| `'lru'` | `maxEntries`, `maxTotalMB` / `maxTotalBytes` | Sorts runtime files by cached timestamp ascending, evicting oldest first |
| `'max-age'` | `maxAgeMs` | Evicts entries older than `maxAgeMs` |
| `'quota'` | `maxQuotaPercent`, `maxQuotaMB` / `maxQuotaBytes`, `preferLargest` | Checks origin quota and evicts entries until under target threshold |
| `'pattern'` | `match` (glob) | Evicts entries whose URL matches glob pattern |
| `'all'` | — | Wipes all runtime cache entries |

---

## Fetch Strategies

| Strategy | Serves from | Falls back to | Caches response | Best for |
|---|---|---|---|---|
| `cache-first` | Cache (offline → runtime) | Network | ✅ Runtime | Static assets, fonts, images |
| `network-first` | Network | Cache (offline → runtime) | ✅ Runtime | HTML pages, user data |
| `network-only` | Network | — | ❌ Never | API mutations (POST/PUT/DELETE) |
| `stale-while-revalidate` | Cache (instant) | Network (block if uncached) | ✅ Runtime | Feeds, listings |
| `cache-only` | Cache | 503 response | ❌ Never | Offline-only fallback |

All intercepted responses carry an `X-Cache-Status` header (`offline-cache`, `runtime-cache`, `network`, `stale`, `offline-fallback`, or `bypass`).
See [docs/STRATEGIES.md](docs/STRATEGIES.md) for detailed behaviour.

---

## Development

```bash
# Install dev dependencies (rollup only)
npm install

# Build both bundles
npm run build

# Watch mode
npm run dev
```

Output:
- `out/sw.js` — Standalone Service Worker (calls `initSW()` itself; copied by `nlpwa init`)
- `out/sw.module.js` — Service Worker library (`import { initSW } from 'nlpwa/sw'`)
- `out/client.js` — Client IIFE (global `NLPWAClient`)
- `out/client.esm.js` — Client ES module (`import { register } from 'nlpwa/client'`)
- `out/config.json` — Runtime configuration starter (`/config.json`)
- `out/rollup-plugin.js` — Rollup/Vite plugin (`import { nlpwa } from 'nlpwa/rollup'`)

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, module map, data flow |
| [docs/CONFIG.md](docs/CONFIG.md) | Full config schema reference |
| [docs/STRATEGIES.md](docs/STRATEGIES.md) | Fetch strategy behaviour & decision guide |
| [docs/UPDATE-PROTOCOL.md](docs/UPDATE-PROTOCOL.md) | Manifest format & update protocol spec |

---

## License

MIT
