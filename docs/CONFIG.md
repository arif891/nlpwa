# NLPWA — Configuration Reference

NLPWA separates **Service Worker engine configuration** (`sw.js`) from **Application configuration** (`config.js`).

---

## 1. Service Worker Initialization (`sw.js`)

In your `sw.js`, call `initSW()` with the SW engine version:

```js
import { initSW } from '/nlpwa.sw.js';

initSW({
  // SW engine logic version — managed manually by the developer
  version: '1',

  // Path to runtime config file (read from and stored in offline cache)
  configPath: '/config.json',
});
```

---

## 2. Application Configuration (`config.js`)

Developers define routes, precached shell files, and update settings in `config.js`. The build tool compiles this into `/config.json`, which the Service Worker stores and reads from the `offline` cache.

```js
export default {
  // Application version (auto-incremented on build/update)
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version',
    info:    '/api/update/info',
  },

  // Update check polling interval
  updateCheckInterval: 60 * 60 * 1000,

  // App shell files to track & offline-cache
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
  ],

  // Per-route fetch strategies
  routes: [
    { match: '/api/**',    strategy: 'network-only' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '**',         strategy: 'network-first' },
  ],
};
```

---

## Configuration Options

### `version` · `string`
The deployed version of your web application.
- Uses semantic versioning (`major.minor.patch`).
- Auto-incremented by the build tool (`nlpwa update`) when building/deploying.
- The Service Worker compares this version during update checks.

---

### `configPath` · `string` · default: `'/config.json'`
The URL pathname where `config.json` is served and cached in the `offline` store.

---

### `updateAPI` · `object` | `Array`
Defines the two-tier update check endpoints:
- `version`: Lightweight endpoint returning `{ "version": "1.0.1" }` (~20 bytes). Polled periodically or on focus.
- `info`: Full manifest endpoint returning `{ "version": "1.0.1", "files": [ { "path": "/config.json", "hash": "..." }, ... ] }`. Only downloaded when a newer version exists.

```js
updateAPI: {
  version: '/api/update/version',
  info:    '/api/update/info',
}
```

*(Also supports array format: `[{ type: 'version', endpoint: '...' }, { type: 'info', endpoint: '...' }]` or legacy `manifestEndpoint`).*

---

### `updateCheckInterval` · `number` (ms) · default: `3600000` (1 hour)

How often the SW automatically polls for updates. Set to `0` to disable
automatic polling (updates are then triggered only by tab focus or a manual
`CHECK_UPDATE` postMessage).

```js
updateCheckInterval: 30 * 60 * 1000,  // every 30 minutes
updateCheckInterval: 0,                // manual only
```

> **Note:** An update check also runs immediately on every SW activation, and
> the client library triggers an additional check when a tab regains focus
> (throttled by `focusThrottleMs`).

---

### `caches` · `object`

Override the default cache storage names.

```js
caches: {
  offline: 'my-app-offline',   // default: 'offline'
  runtime: 'my-app-runtime',   // default: 'runtime'
}
```

If you deploy multiple apps on the same origin, use distinct names to avoid
cache collisions.

---

### `verifyHashes` · `'strict' | 'warn' | false` · default: `'strict'`

How each downloaded update file is checked against the hash in the update manifest.

- `'strict'` - a mismatch (or an HTML error page served with status 200) fails that file. The update is not applied until every file verifies, and it is retried on the next check. The running version is untouched.
- `'warn'` - mismatches are logged but the file is stored. Use this only if a proxy or CDN rewrites your files after the build, which makes the build-time hash impossible to match.
- `false` - no verification.

```js
verifyHashes: 'strict'
```

---

### `manifestCachePath` · `string` · default: `'/_nlpwa/manifest.json'`

The key used to store the manifest snapshot inside the `offline` cache.
This is an internal URL — it is never served to the browser.

```js
manifestCachePath: '/_nlpwa/manifest.json'
```

Only change this if the default path conflicts with a real file in your app.

---

### `precache` · `string[]` · default: `[]`

List of URL paths to fetch and store in the `offline` cache at SW install time.
These form your **app shell** — the minimum set of resources needed to render
the app without a network connection.

```js
precache: [
  '/',
  '/index.html',
  '/app.js',
  '/styles/main.css',
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
]
```

**Guidelines:**
- Include the entry point HTML (`/` or `/index.html`)
- Include critical JS and CSS
- Do **not** include API responses or user-specific data
- Large media files are better left to runtime caching

Individual precache failures are logged as warnings and do **not** abort the
SW install. They will be retried on the next update check.

---

### `routes` · `Array<{ match, strategy }>` · default: `[]`

Per-URL-pattern fetch strategy rules. Matched **top-to-bottom**; the first
matching rule wins. Unmatched requests fall through to `defaultStrategy`.

```js
routes: [
  { match: '/api/**',         strategy: 'network-only'           },
  { match: '/assets/fonts/**',strategy: 'cache-first'            },
  { match: '/assets/**',      strategy: 'cache-first'            },
  { match: '/pages/**',       strategy: 'network-first'          },
  { match: '/_feeds/**',      strategy: 'stale-while-revalidate' },
  { match: '/offline.html',   strategy: 'cache-only'             },
  { match: '**',              strategy: 'network-first'          },  // catch-all
]
```

#### `match` — Glob pattern

| Syntax | Matches | Example |
|---|---|---|
| `*` | Any characters except `/` | `/pages/*` matches `/pages/about` |
| `**` | Any characters including `/` | `/assets/**` matches `/assets/img/logo.png` |
| `?` | Any single character except `/` | `/page?` matches `/pages` |
| Literal | Exact pathname | `/offline.html` |

Patterns are matched against the **pathname** of the request URL (not the full URL).

#### `strategy` — Fetch strategy

| Value | Description |
|---|---|
| `'cache-first'` | Cache → Network. Best for: static assets |
| `'network-first'` | Network → Cache fallback. Best for: HTML pages |
| `'network-only'` | Network always. Best for: API writes |
| `'stale-while-revalidate'` | Cache instantly, update in background. Best for: feeds |
| `'cache-only'` | Cache only, 503 on miss. Best for: offline fallback |

See [STRATEGIES.md](STRATEGIES.md) for full strategy behaviour.

---

### `defaultStrategy` · `string` · default: `'network-first'`

The strategy to use when a request URL does not match any route in `routes`.
Acts as a safety net catch-all.

```js
defaultStrategy: 'network-first'
```

Must be one of the five strategy names listed above.

---

## Full Example

```js
import { initSW } from '/nlpwa.sw.js';

initSW({
  // ── Identity ───────────────────────────────────────────────────────────────
  version: '2.1.0',

  // ── Update ─────────────────────────────────────────────────────────────────
  manifestEndpoint:    '/api/manifest/latest',
  updateCheckInterval: 60 * 60 * 1000,          // 1 hour

  // ── Caches ─────────────────────────────────────────────────────────────────
  caches: {
    offline: 'myapp-offline',
    runtime: 'myapp-runtime',
  },

  // ── App shell ──────────────────────────────────────────────────────────────
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
    '/offline.html',
    '/assets/icons/icon-192.png',
    '/assets/icons/icon-512.png',
    '/manifest.webmanifest',
  ],

  // ── Routing ────────────────────────────────────────────────────────────────
  routes: [
    // API: never cache — always fresh, includes auth headers
    { match: '/api/**',          strategy: 'network-only'           },

    // Static assets: cache aggressively (long-lived content-hashed files)
    { match: '/assets/**',       strategy: 'cache-first'            },
    { match: '/fonts/**',        strategy: 'cache-first'            },

    // Pages: prefer network, fall back to cache when offline
    { match: '/pages/**',        strategy: 'network-first'          },

    // Feeds & listings: serve immediately from cache, update in background
    { match: '/_feeds/**',       strategy: 'stale-while-revalidate' },

    // Offline fallback page: only ever served from cache
    { match: '/offline.html',    strategy: 'cache-only'             },

    // Everything else: prefer network
    { match: '**',               strategy: 'network-first'          },
  ],

  defaultStrategy: 'network-first',
});
```

---

## Config Validation

NLPWA validates your config at startup and logs any errors to the SW console
with clear messages. Invalid config does **not** throw — the SW continues with
the merged defaults so the app doesn't break in production.

Check the browser DevTools → Application → Service Workers console for messages
starting with `[NLPWA]`.
