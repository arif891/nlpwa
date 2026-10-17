# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, and seamless OTA (over-the-air) delta updates — all from three drop-in files (or npm package exports).

---

## Features

- **Decoupled SW vs. App versioning** — SW engine version is managed manually; App version is auto-incremented by build tool
- **Dynamic runtime configuration** — write routes in `config.js`; SW reads from `offline` cache for instant updates without SW reinstall
- **Only offline files tracked** — build tool tracks & hashes only `config.json` and precached app shell files
- **Two-tier update check** — lightweight version check first (~20 bytes); full manifest only downloaded when an update exists
- **5 fetch strategies** per URL pattern (glob routing)
- **Hash-based OTA delta updates** — only changed files are re-fetched, and every download is verified against its manifest hash
- **Atomic updates** — new versions are staged in a separate cache and switched in with one pointer write; a failed or interrupted update never affects the running app
- **Route-aware cache eviction** — stale entries removed automatically on route change
- **Self-healing cache** — failed fetches retry on next update check
- **Three drop-in files** — `sw.js` (core engine), `config.js` (routes/settings), and `client.js` (runtime SDK)

---

## Quick Start

### 1. Initialize in Your Project

You can drop NLPWA into any project with a single command:

```bash
# Drop sw.js, client.js, and config.js into current directory
npx nlpwa init

# Or target a public directory
npx nlpwa init --dir ./public
```

Your project now has:
```
your-app/
├── sw.js         ← Standalone Service Worker engine
├── client.js     ← Client SDK (exports NLPWAClient / register)
├── config.js     ← Developer configuration (routes, precache, endpoints)
├── config.json   ← Compiled runtime config (for offline cache)
└── index.html
```

### 2. Configure Your App in `config.js`

Developers edit `config.js` directly:

```js
export default {
  // App version (auto-incremented by `nlpwa update`)
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },

  // Check for updates every hour
  updateCheckInterval: 60 * 60 * 1000,

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
    { match: '/pages/**',     strategy: 'network-first', networkTimeoutMs: 3000 },
    { match: '/_feeds/**',    strategy: 'stale-while-revalidate' },
    { match: '**',            strategy: 'network-first'          },
  ],
};
```

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

Run the build tool to auto-increment the patch version, compile `config.js` into `config.json`, hash offline files, and emit the update API endpoints:

```bash
# Auto-increments patch version (1.0.0 → 1.0.1) and outputs to ./dist
npx nlpwa update --dir ./dist
```

This generates:
- `dist/config.json` (runtime config for the SW offline cache)
- `dist/api/update/version.json` (`{ "version": "1.0.1" }`)
- `dist/api/update/info.json` (`{ "version": "1.0.1", "files": [...] }`)

*(Note: If custom endpoint paths do not end with `.json`, e.g. `/api/update/version`, the CLI automatically generates directory `index.json` files).*

Manifest hashes are the first 32 hex characters of each file's SHA-256 digest.

#### CLI Reference

| Command / Flag | Default | Description |
|---|---|---|
| `npx nlpwa init [--dir <path>]` | `./` | Copies `sw.js`, `client.js`, and `config.js` to target directory |
| `npx nlpwa update [--dir <path>]` | `./dist` or `./` | Increments patch version, builds `config.json`, hashes offline files, and emits update API |
| `--config <path>` | auto-detect | Path to custom config file (e.g. `./src/config.js`) |
| `--version <semver>` | auto-increment | Explicit version override (e.g. `2.0.0`) |
| `--pretty` | `false` | Pretty-print output JSON files with 2-space indentation (compact by default) |

### 5. Bundler Integration (Vite / Rollup)

If you use Vite or Rollup, you can automate updates on every build using the bundled plugin:

```js
// vite.config.js or rollup.config.js
import { defineConfig } from 'vite';
import nlpwa from 'nlpwa/rollup';

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

First install runs the same pipeline during `install` and switches at once (no prompt), so the first update check has nothing left to download. If a file keeps failing, the old version stays live; after 5 consecutive failed checks the update goes ahead without that file (it keeps its old copy) and is retried on the next version bump.

---

## API Reference

### Service Worker: `initSW(config)`

See [docs/CONFIG.md](docs/CONFIG.md) for full config reference.

### Client: `NLPWAClient.register(swUrl, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `onUpdateReady` | `Function` | — | Called with `{ version, partial }` when update is ready |
| `autoReload` | `boolean` | `false` | Reload automatically on update (deferred if user is typing in inputs) |
| `checkOnFocus` | `boolean` | `true` | Check for update when tab gains focus |
| `focusThrottleMs` | `number` | `300000` | Min ms between focus-triggered checks (5 min) |
| `pollIntervalMs` | `number` | `3600000` | Client interval (ms) to check updates while tab is active (1 hr) |

### Client: `NLPWAClient.applyUpdate(options)`

Asks the SW to switch to the staged update via `APPLY_UPDATE` message, waits for `UPDATE_APPLIED` confirmation (default timeout: 3000ms), and then reloads the page. (A plain navigation or reload also applies the update automatically.)

### Client events

```js
// CustomEvent fired on document when update is ready
document.addEventListener('nlpwa:update-ready', (e) => {
  console.log('New version:', e.detail.version, 'Partial:', e.detail.partial);
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
- `out/config.js` — Configuration template
- `out/config.json` — Generated runtime config

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
