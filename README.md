# NLPWA — Native-like PWA Framework

A lightweight, zero-runtime-dependency Service Worker framework that makes Progressive Web Apps feel truly native. It handles install-time caching, per-route fetch strategies, and seamless OTA (over-the-air) delta updates — all from two drop-in JS files.

---

## Features

- **App shell pre-caching** at install time
- **5 fetch strategies** per URL pattern (glob routing)
- **Hash-based OTA updates** — only changed files are re-fetched
- **Route-aware cache eviction** — stale entries removed automatically
- **Self-healing cache** — failed fetches retry on next update check
- **No rollback complexity** — graceful degradation, not transactions
- **Two drop-in files** — `sw.js` + `client.js`, no build pipeline required for consumers

---

## Quick Start

### 1. Copy the built files into your app

```
your-app/
├── sw.js           ← your Service Worker (you write this)
├── nlpwa.sw.js     ← build/sw.js  (copy here)
├── nlpwa.client.js ← build/client.js  (copy here)
└── index.html
```

### 2. Create your `sw.js`

```js
import { initSW } from '/nlpwa.sw.js';

initSW({
  version: '1.0.0',

  // Files to cache immediately at install time (app shell)
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
    '/assets/icons/icon-192.png',
  ],

  // Per-route fetch strategies (matched top-to-bottom)
  routes: [
    { match: '/api/**',       strategy: 'network-only'           },
    { match: '/assets/**',    strategy: 'cache-first'            },
    { match: '/pages/**',     strategy: 'network-first'          },
    { match: '/_feeds/**',    strategy: 'stale-while-revalidate' },
    { match: '**',            strategy: 'network-first'          },
  ],

  // Endpoint that returns the current file tree manifest
  manifestEndpoint: '/api/manifest/latest',

  // Check for updates every hour
  updateCheckInterval: 60 * 60 * 1000,
});
```

### 3. Register from your HTML

```html
<!-- In index.html, before closing </body> -->
<script src="/nlpwa.client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version }) => {
      // Show your own UI — a banner, toast, modal, etc.
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

### 4. Serve a manifest endpoint from your server

```json
GET /api/manifest/latest

{
  "version": "1.0.0",
  "files": [
    { "path": "/app.js",          "hash": "a1b2c3d4" },
    { "path": "/styles/main.css", "hash": "e5f6a7b8" },
    { "path": "/index.html",      "hash": "c9d0e1f2" }
  ]
}
```

The `hash` is any stable content hash per file (e.g. SHA-256 truncated to 8 hex chars, or an ETag). The server never needs to compute diffs — NLPWA does that entirely on the client.

---

## Cache Storage

NLPWA uses exactly **two** named caches:

| Cache | Purpose |
|---|---|
| `offline` | App shell (precache) + internal manifest snapshot at `/_nlpwa/manifest.json` |
| `runtime` | Assets cached lazily on first request; evicted when stale |

No versioned caches. No meta cache. The manifest snapshot inside `offline` is the single source of truth for what's currently installed.

---

## Update Flow

```
1. SW active → triggers update check (on activate + every N ms + on tab focus)
2. GET /api/manifest/latest  →  { version, files: [{path, hash}] }
3. Compare server version vs config.version  →  same? stop.
4. Load /_nlpwa/manifest.json from offline cache  →  previous hash map
5. Hash diff: added | modified | removed
6. Fetch & store added/modified in offline cache  (failures skip, self-heal next check)
7. Delete removed from offline cache
8. Evict runtime entries whose hash changed or file was removed
9. Route-aware eviction: evict cached files whose URL no longer matches
   a caching-capable route (cache-first | network-first | SWR | cache-only)
10. Save new manifest snapshot
11. postMessage UPDATE_READY → client shows update prompt
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
