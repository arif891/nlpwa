# NLPWA — Configuration Reference

NLPWA separates **Service Worker engine configuration** (`sw.js`) from **Application configuration** (`config.js`).

---

## 1. Service Worker Initialization (`sw.js`)

In your `sw.js`, call `initSW()` with the SW engine version:

```js
import { initSW } from 'nlpwa/sw';

initSW({
  // SW engine logic version — managed manually by the developer
  version: '1',

  // Path to runtime config file (read from and stored in offline cache)
  configPath: '/config.json',
});
```

---

## 2. Application Configuration (`config.json` or `config.js`)

Developers define routes, precached shell files, and update settings in `config.json` (or `config.js` when using a bundler). In standalone mode, `/config.json` is read directly from the web server into the `offline` cache. When using `nlpwa update`, the CLI automatically compiles and syncs the runtime `config.json`.

```js
export default {
  // Application version (auto-incremented on build/update)
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
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

### `version` · `string` · default: `'auto'`
The deployed version of your web application.

- **Deterministic Hash Derivation (Default):** When you run `nlpwa update` or the Rollup/Vite plugin, NLPWA computes a composite SHA-256 hash of all tracked files and configuration rules:
  - If `version: '1.0.0'` is set in `config.js`, the emitted version is formatted as `1.0.0-<hash>` (e.g. `1.0.0-a1b2c3d4e5f6`).
  - If `version: 'auto'` or omitted, the version is the pure content hash (e.g. `a1b2c3d4e5f6`).
- **Idempotent & CI-Safe:** Rebuilding identical code in CI or local development produces the exact same hash, preventing clients from receiving spurious "Update ready" banners when nothing changed.
- **Rollback-Safe:** Reverting a Git commit to an earlier release regenerates that release's exact hash, allowing clients to roll back automatically.
- **Zero Source File Rewriting:** Your source `config.js` is treated as read-only, avoiding dirty Git working trees and infinite rebuild loops in `rollup --watch`.
- **Manual Semver Mode (Opt-in):** If you prefer classical patch increments, pass `--bump-patch` to `nlpwa update` (or `autoIncrement: true` in the plugin). To sync the bumped version back to your source file, add `--sync-source`.

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
  version: '/api/update/version.json',
  info:    '/api/update/info.json',
}
```

> **CLI Output Handling:** When you run `nlpwa update`, the CLI automatically resolves the disk output based on your endpoints:
> - If an endpoint ends with `.json` (e.g. `/api/update/version.json`), it generates `dist/api/update/version.json`.
> - If an endpoint has no extension (e.g. `/api/update/version`), it generates directory `index.json` files (`dist/api/update/version/index.json`).

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
  '/assets/icons/**',      // Glob patterns automatically expanded at build time
]
```

**Glob Pattern Support:**
You can specify glob patterns in `precache` (such as `'/assets/icons/**'` or `'/fonts/*.*'`). The build tools (`nlpwa update`, `nlpwa build`, and the Rollup/Vite plugin) automatically scan your output directory, expand all matching files, compute their SHA-256 hashes, and include them in the update manifest and generated `config.json`.

**Guidelines:**
- Include the entry point HTML (`/` or `/index.html`)
- Include critical JS, CSS, and icons/fonts
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
| Full URL | External CDN or cross-origin endpoint | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/**` |

#### Cross-Origin & CDN Asset Caching

NLPWA supports caching cross-origin assets (such as CDN-hosted ONNX Runtime `.wasm` files, AI models, or third-party fonts).

You can define cross-origin routes in either of two ways:

1. **Direct Full URL:**
   ```js
   {
     match: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/**',
     strategy: 'cache-first',
   }
   ```
2. **Explicit `origin` + `match`:**
   ```js
   {
     origin: 'https://cdn.jsdelivr.net',
     match: '/npm/onnxruntime-web@1.30.0/**',
     strategy: 'cache-first',
   }
   ```
   *(Wildcard origins like `origin: '*'` are also supported to apply a strategy to all origins matching the path pattern).*

Cross-origin responses—including opaque responses (`status: 0`) from `<script>` or WebAssembly workers—are safely stored in the `runtime` cache and served offline.

#### `maxAge` / `ttl` · `string | number` · default: `undefined`

Maximum time a dynamic runtime cache entry remains valid before being considered stale. Supports human-friendly strings like `'7d'`, `'24h'`, `'30m'`, `'60s'`, `'500ms'`, or milliseconds as a number (also accepts `maxAgeSeconds: 3600`).

- When a request matches an entry in the runtime cache whose age exceeds `maxAge`, `cache-first` automatically fetches a fresh version from the network, updates the runtime cache, and serves the new copy.
- If the device is offline or the network request fails, it gracefully falls back to the stale cached response rather than breaking the application.

```js
// Cache images aggressively but revalidate after 7 days
{ match: '/assets/**', strategy: 'cache-first', maxAge: '7d' }
```

#### `throwOnFailure` · `boolean` · default: `false`

Controls whether network and cache lookup failures throw an error instead of returning a synthetic `503 Service Unavailable` response.

- `false` (default): Network or cache failures produce a synthetic `503 Service Unavailable` response with an `X-Cache-Status: offline-fallback` header. This prevents unhandled promise rejections in simple websites.
- `true`: When a request cannot be fulfilled (e.g. offline with `network-only`, or cache miss with `cache-only`), the strategy re-throws the underlying `TypeError: Failed to fetch`. This allows client application code (`fetch().catch(...)`, TanStack Query, SWR, Axios, or offline mutation queues) to detect offline states and queue background writes reliably.

Can also be set globally in `config.js` to apply to all routes by default.

```js
// Rethrow errors on API endpoints so client code can catch offline state
{ match: '/api/**', strategy: 'network-only', throwOnFailure: true }
```

#### `strategy` — Fetch strategy

| Value | Description |
|---|---|
| `'cache-first'` | Cache → Network. Best for: static assets, CDN libraries |
| `'network-first'` | Network → Cache fallback. Best for: HTML pages |
| `'network-only'` | Network always. Best for: API writes |
| `'stale-while-revalidate'` | Cache instantly, update in background. Best for: feeds |
| `'cache-only'` | Cache only, 503 on miss (or throws if `throwOnFailure: true`). Best for: offline fallback |

See [STRATEGIES.md](STRATEGIES.md) for full strategy behaviour.

---

### `clearRuntimeOnUpdate` · `boolean` · default: `false`

Controls whether the entire `runtime` cache is deleted when a new version update commits.

- `false` (default): Preserves runtime cached assets across version updates, evicting only files that were modified or removed in the update manifest.
- `true`: Completely clears the runtime cache upon committing a new version. Recommended as a safety net if your application serves unfingerprinted static assets via `cache-first` outside of `precache`, ensuring no stale runtime assets linger after a deployment.

```js
clearRuntimeOnUpdate: true
```

---

### `base` · `string` · default: `''`

Base public path where the application is hosted (e.g. `'/my-app/'` for subpath deployments or GitHub Pages).
When specified, `configPath` and update API endpoints automatically resolve relative to this base path.

```js
base: '/my-app/'
```

---

### `retainPreviousVersionCache` · `boolean` · default: `false`

Controls whether the immediate prior version's offline cache is preserved when an update commits.

- `false` (default): Immediately prunes the old offline cache on commit to conserve storage quota.
- `true`: Keeps the immediate prior version's cache in storage alongside the new version. `getFromOffline` automatically falls back to the retained cache if an asset misses in the active cache. Recommended for multi-tab applications and SPAs so open background tabs don't experience 404s when lazy-loading older chunk files (`import('./chunk-v1.js')`) before they navigate or reload.

```js
retainPreviousVersionCache: true
```

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

### `sw.js` (Service Worker Engine)

```js
import { initSW } from 'nlpwa/sw';

initSW({
  // SW engine logic version — managed manually by the developer
  version: '1',

  // Path to runtime config file (read from and stored in offline cache)
  configPath: '/config.json',
});
```

### `config.js` (Application Configuration)

```js
export default {
  // ── Identity ───────────────────────────────────────────────────────────────
  version: '2.1.0',

  // ── Update ─────────────────────────────────────────────────────────────────
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },
  updateCheckInterval: 60 * 60 * 1000,          // 1 hour
  verifyHashes: 'strict',                        // 'strict' | 'warn' | false

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
};
```

---

## Config Validation

NLPWA validates your config at startup and logs any errors to the SW console
with clear messages. Invalid config does **not** throw — the SW continues with
the merged defaults so the app doesn't break in production.

Check the browser DevTools → Application → Service Workers console for messages
starting with `[NLPWA]`.
