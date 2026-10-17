# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, and seamless OTA (over-the-air) delta updates — all from two drop-in JS files.

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
    version: '/api/update/version',
    info:    '/api/update/info',
  },

  // Check for updates every hour
  updateCheckInterval: 60 * 60 * 1000,

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
    { match: '/pages/**',     strategy: 'network-first'          },
    { match: '/_feeds/**',    strategy: 'stale-while-revalidate' },
    { match: '**',            strategy: 'network-first'          },
  ],
};
```

### 3. Initialize the Service Worker (`sw.js`)

Your `sw.js` is the core engine. You only need to touch it when changing the low-level Service Worker engine version:

```js
import { initSW } from '/nlpwa.sw.js';

initSW({
  // SW engine version (managed manually by dev)
  version: '1',
  // Path to runtime config (always read from and stored in offline cache)
  configPath: '/config.json',
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
- `dist/api/update/version/index.json` (`{ "version": "1.0.1" }`)
- `dist/api/update/info/index.json` (`{ "version": "1.0.1", "files": [...] }`)

### 5. Register from your HTML

```html
<!-- In index.html, before closing </body> -->
<script type="module" src="/client.js"></script>
<script type="module">
  import { register, applyUpdate } from '/client.js';

  register('/sw.js', {
    onUpdateReady: ({ version }) => {
      document.getElementById('update-banner').hidden = false;
    },
  });
</script>

<!-- Example update banner -->
<div id="update-banner" hidden>
  A new version is available.
  <button onclick="window.NLPWAClient.applyUpdate()">Refresh</button>
</div>
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
2. Tier 1: GET /api/update/version → { version }
3. Compare against the live version → already up to date? STOP immediately.
4. Tier 2: GET /api/update/info → { version, files: [{path, hash}] }
5. Stage a new offline@<version> cache (the running app is not touched):
   - unchanged files (same hash as live) are copied locally, no network
   - added/modified files are fetched (no-store) and their SHA-256 is
     checked against the manifest (config.verifyHashes)
   - files that verified earlier are reused when a failed update is retried
6. Write the snapshot last (marks the staged cache complete)
7. postMessage UPDATE_READY → client shows the update prompt
8. On the next page load (or NLPWAClient.applyUpdate()):
   switch the active pointer, reload config.json, evict changed entries from
   the runtime cache, route-aware eviction, delete the old offline cache
```

First install runs the same pipeline during `install` and switches at once (no prompt), so the first update check has nothing left to download. If a file keeps failing, the old version stays live; after 5 consecutive failed checks the update goes ahead without that file (it keeps its old copy) and is retried on the next version bump.

---

## API Reference

### Service Worker: `initSW(config)`

See [docs/CONFIG.md](docs/CONFIG.md) for full config reference.

### Client: `NLPWAClient.register(swUrl, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `onUpdateReady` | `Function` | — | Called with `{ version }` when update is ready |
| `autoReload` | `boolean` | `false` | Reload automatically on update |
| `checkOnFocus` | `boolean` | `true` | Check for update when tab gains focus |
| `focusThrottleMs` | `number` | `300000` | Min ms between focus-triggered checks |

### Client: `NLPWAClient.applyUpdate()`

Asks the SW to switch to the staged update, then reloads the page. (A plain reload also applies it, because the switch happens on navigation.)

### Client events

```js
// CustomEvent fired on document when update is ready
document.addEventListener('nlpwa:update-ready', (e) => {
  console.log('New version:', e.detail.version);
});
```

### Manual update check (from client JS)

```js
// Trigger a check without waiting for the next poll interval
navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_UPDATE' });
```

---

## Fetch Strategies

| Strategy | Serves from | Falls back to | Caches response | Best for |
|---|---|---|---|---|
| `cache-first` | Cache | Network | ✅ Runtime | Static assets, fonts, images |
| `network-first` | Network | Cache | ✅ Runtime | HTML pages, user data |
| `network-only` | Network | — | ❌ Never | API mutations (POST/PUT/DELETE) |
| `stale-while-revalidate` | Cache (instant) | Network (block) | ✅ Runtime | Feeds, listings |
| `cache-only` | Cache | 503 response | ❌ Never | Offline-only fallback |

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
- `out/sw.js` — Service Worker bundle (standalone core engine)
- `out/client.js` — Client bundle (`NLPWAClient` & ES module exports)
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
