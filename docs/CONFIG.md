# NLPWA — Configuration Reference

Pass your config to `initSW()` inside your Service Worker file:

```js
import { initSW } from '/nlpwa.sw.js';

initSW({
  version: '1.0.0',
  // ... see options below
});
```

---

## All Options

### `version` · `string` · **required**

The current version of your application. Compared against the `version` field
in the server manifest to decide whether an update is available.

```js
version: '1.4.2'
```

Uses semantic versioning (`major.minor.patch`). Non-numeric pre-release suffixes
are ignored in comparisons.

---

### `manifestEndpoint` · `string` · default: `'/api/manifest/latest'`

URL of the server endpoint that returns the current file tree manifest.

```js
manifestEndpoint: '/api/manifest/latest'
```

The endpoint must return JSON in this shape:

```json
{
  "version": "1.4.2",
  "files": [
    { "path": "/app.js",        "hash": "a1b2c3d4" },
    { "path": "/index.html",    "hash": "e5f6a7b8" }
  ]
}
```

- `version` — the current deployed version string
- `files` — complete list of all cacheable files with their content hashes
- `path` — URL pathname (must start with `/`)
- `hash` — any stable content identifier (SHA-256 hex truncated, ETag, build hash, etc.)

The server **never** needs to compute diffs. NLPWA compares hashes client-side.

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
