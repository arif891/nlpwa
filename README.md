# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, and seamless OTA (over-the-air) delta updates — all from two drop-in JS files.

---

## Features

- **Decoupled SW vs. App versioning** — SW engine version is managed manually; App version is auto-incremented by build tool
- **Dynamic runtime configuration** — write routes in `config.js`; SW reads from `offline` cache for instant updates without SW reinstall
- **Only offline files tracked** — build tool tracks & hashes only `config.json` and precached app shell files
- **Two-tier update check** — lightweight version check first (~20 bytes); full manifest only downloaded when an update exists
- **5 fetch strategies** per URL pattern (glob routing)
- **Hash-based OTA delta updates** — only changed files are re-fetched
- **Route-aware cache eviction** — stale entries removed automatically on route change
- **Self-healing cache** — failed fetches retry on next update check
- **Three drop-in files** — `sw.js` (core engine), `config.js` (routes/settings), and `client.js` (runtime SDK)

---

## Quick Start

### 1. The Three Distribution Files

```
your-app/
├── sw.js           ← your Service Worker entry (calls initSW)
├── config.js       ← your app config (routes, precache, endpoints)
├── nlpwa.sw.js     ← build/sw.js  (core engine)
├── nlpwa.client.js ← build/client.js  (client SDK)
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
<script src="/nlpwa.client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version }) => {
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

---

## Cache Storage

NLPWA uses exactly **two** named caches:

| Cache | Purpose |
|---|---|
| `offline` | App shell (`precache`) + runtime `config.json` + internal snapshot `/_nlpwa/manifest.json` |
| `runtime` | Assets cached lazily on first request; evicted when stale |

The config file and manifest snapshot inside `offline` are the single source of truth for what's currently active.

---

## Two-Tier Update Flow

```
1. SW active → triggers check (on activate + every interval + tab focus)
2. Tier 1: GET /api/update/version → { version }
3. Compare against cached app version → already up to date? STOP immediately.
4. Tier 2: GET /api/update/info → { version, files: [{path, hash}] }
5. Load previous manifest snapshot from offline cache
6. Hash diff: added | modified | removed
7. Fetch & store added/modified in offline cache
   - If /config.json was modified: updates offline cache & reloads routes dynamically!
8. Delete removed files from offline cache
9. Evict stale runtime entries
10. Route-aware eviction: clean entries no longer matching cacheable routes
11. Save new manifest snapshot
12. postMessage UPDATE_READY → client shows update prompt
```

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

Reloads the page to apply the waiting update.

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
- `build/sw.js` — ES module Service Worker bundle
- `build/client.js` — IIFE client bundle (`window.NLPWAClient`)

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
