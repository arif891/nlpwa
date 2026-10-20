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
  configPath: '/api/update/config.json',
});
```

---

## 2. Application Configuration (`nlpwa.config.js`)

Developers define routes, precached shell files, and update settings in `nlpwa.config.js`. In standalone mode, `/api/update/config.json` is read directly from the web server into the `offline` cache. When using `nlpwa update`, the CLI automatically compiles and emits the runtime `api/update/config.json`.

```js
export default {
  // Application base version (used as prefix for content-derived version, e.g. 1.0.0-<hash>)
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },

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

### `configPath` · `string` · default: `'/api/update/config.json'`
The URL pathname where `api/update/config.json` is served and cached in the `offline` store.

---

### `updateAPI` · `object` | `Array`
Defines the two-tier update check endpoints:
- `version`: Lightweight endpoint returning `{ "version": "1.0.1" }` (~20 bytes). Polled periodically or on focus.
- `info`: Full manifest endpoint returning `{ "version": "1.0.1", "files": [ { "path": "/api/update/config.json", "hash": "..." }, ... ] }`. Only downloaded when a newer version exists.

```js
updateAPI: {
  version: '/api/update/version.json',
  info:    '/api/update/info.json',
}
```

> **CLI Output Handling:** When you run `nlpwa update`, the CLI automatically resolves the disk output based on your endpoints:
> - If an endpoint ends with `.json` (e.g. `/api/update/version.json`), it generates `dist/api/update/version.json`.
> - If an endpoint has no extension (e.g. `/api/update/version`), it generates directory `index.json` files (`dist/api/update/version/index.json`).

---

### Polling for Updates · Client SDK (`pollIntervalMs`, `periodicSync`)

Because modern browsers terminate idle Service Workers after ~30 seconds of inactivity, in-worker `setInterval` polling cannot run reliably when the SW is idle. Reliable periodic polling is configured via the **client SDK** running in open browser tabs:

```js
import { NLPWAClient } from 'nlpwa/client';

NLPWAClient.register('/sw.js', {
  pollIntervalMs: 60 * 60 * 1000, // Poll every hour while the app is open
  checkOnFocus: true,             // Check whenever user switches back to the tab
  periodicSync: true,             // Periodic Background Sync for installed PWAs (default: true)
});
```

- `periodicSync` (`boolean`, default: `true`): When true (or omitted), automatically registers Periodic Background Sync with the browser using `minInterval: pollIntervalMs` if supported for installed PWAs. Pass `periodicSync: false` to opt out.

---

### `caches` · `object`

Override the default cache storage names.

```js
caches: {
  offline: 'my-app-offline',   // default: 'offline'
  runtime: 'my-app-runtime',   // default: 'runtime'
  meta:    'my-app-meta',      // default: 'nlpwa-meta'
}
```

If you deploy multiple apps on the same origin, use distinct names to avoid
cache collisions.

---

### `verifyHashes` · `'strict' | 'warn' | false` · default: `'strict'`

How each downloaded update file is checked against the hash in the update manifest.

- `'strict'` - a mismatch (or an HTML error page served with status 200) fails that file. The update is not applied until every file verifies, and it is retried on the next check. If consecutive retries repeatedly fail on the same file due to hash mismatches, a persistent failure warning is logged and broadcast to clients via `UPDATE_FAILED`. The running version is untouched.
  *(Exception: Files exceeding `maxVerifyBytes` skip in-memory SHA-256 verification even in strict mode to prevent out-of-memory crashes on low-end devices, logging a warning instead)*.
- `'warn'` - mismatches are logged but the file is stored. Use this only if a proxy or CDN rewrites your files after the build, which makes the build-time hash impossible to match.
- `false` - no verification.

> [!NOTE]
> Manifest hashes are SHA-256 digests served from the same origin (`info.json`). They verify content integrity against network transport corruption, captive portals returning 200 HTML for missing files, proxy caching glitches, and partial deployments—not a compromise of the web server origin itself.

```js
verifyHashes: 'warn'
```

---

### `maxVerifyBytes` · `number` · default: `20971520` (20 MB)

Maximum file size in bytes to buffer and verify with in-memory SHA-256 hashing during update staging. In strict verification mode (`verifyHashes: 'strict'`), files exceeding this threshold are rejected with an explicit error to prevent mobile out-of-memory browser crashes.

```js
maxVerifyBytes: 20 * 1024 * 1024 // 20 MB
```

---

### `allowOversizedUnverified` · `boolean` · default: `false`

When set to `true`, files exceeding `maxVerifyBytes` bypass in-memory SHA-256 verification and are stored directly in `CacheStorage` with a console warning.

> [!TIP]
> **Best Practice**: Only core app shell files (HTML, JS, CSS, icons) should be placed in `precache`. Large media (videos, heavy 3D assets, AI weights) should be routed through runtime `cache-first` caching instead of `precache` to eliminate memory pressure entirely.

```js
allowOversizedUnverified: true
```

---

### `snapshotCachePath` · `string` · default: `'/_nlpwa/snapshot.json'`

The key used to store the manifest snapshot inside the `offline` cache.
This is an internal URL — it is never served to the browser.

```js
snapshotCachePath: '/_nlpwa/snapshot.json'
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
- Keep precache lean: large media files (videos, high-res images, 3D models) should be cached via runtime routes

> [!IMPORTANT]
> **Precached Files Are Strictly Cache-First (Non-Overridable)**
> Every file listed in `precache` is automatically served `cache-first` directly from the active `offline@...` cache. **Route configurations cannot override this behavior.** Even if you define `{ match: '/app.js', strategy: 'network-first' }` or `{ match: '/index.html', strategy: 'network-only' }`, the precache atomicity rule takes precedence.
>
> - **Why:** Prevents runtime version skew (e.g. running v2 HTML against v1 JS chunks).
> - **Hotfix Surprise:** You cannot bypass the cache or "hotfix" a precached file on the server by simply modifying server files or changing route strategies. The SW will continue serving the active version from cache.
> - **Update Flow:** To deploy updates or hotfixes to precached assets, run `npx nlpwa update` (or let your CI/CD build run) to generate new manifest hashes. The Service Worker will stage the update in the background and activate it cleanly.

> [!WARNING]
> **Keep Precache Lean (Memory Footprint)**:
> During update staging and integrity verification, `fetchVerified` clones and buffers each downloaded response into memory as an `ArrayBuffer` to compute its SHA-256 digest before storing the original response into `CacheStorage`. For typical app shell files (HTML, JS, CSS, SVG icons), memory overhead is negligible. However, putting large multi-megabyte files into `precache` will temporarily double peak memory usage while hashing.
> 
> Keep `precache` strictly limited to essential app shell assets, and route large media or binary assets through runtime caching routes (`cache-first` or `network-first` with `maxItemMB` eviction).

On first install, precache failures reject `install` to prevent activating an empty or broken offline cache. During subsequent background updates, individual file staging failures are recorded, leaving the active version serving cleanly while retries enter exponential backoff.

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
]
```

> [!IMPORTANT]
> **Built-In Shell Atomicity Rule: Precached Files Cannot Be Overridden**
> All precached and manifest files (your HTML shell, JS bundles, CSS, and icons) are **automatically served `cache-first` from the active offline cache** via an internal, non-overridable rule evaluated before `routes`.
>
> Even if your configuration defines `{ match: '/index.html', strategy: 'network-first' }` or uses `defaultStrategy: 'network-first'`, the precached app shell is never fetched raw from the network while an update is being staged. This guarantees that running tabs never serve mixed old/new files and that updates commit atomically. To deploy updates or hotfixes to precached files, run `nlpwa update` to emit a new manifest.

#### `match` — Glob pattern

| Syntax   | Matches                               | Example                                                  |
| -------- | ------------------------------------- | -------------------------------------------------------- |
| `*`      | Any characters except `/`             | `/pages/*` matches `/pages/about`                        |
| `**`     | Any characters including `/`          | `/assets/**` matches `/assets/img/logo.png`              |
| `?`      | Any single character except `/`       | `/page?` matches `/pages`                                |
| Literal  | Exact pathname                        | `/offline.html`                                          |
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

#### `maxAge` · `string | number` · default: `undefined`

Maximum time a dynamic runtime cache entry remains valid before being considered stale. Supports human-friendly strings like `'7d'`, `'24h'`, `'30m'`, `'60s'`, `'500ms'`, or milliseconds as a number.

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

#### `fallbackOn5xx` · `boolean` · default: `false`

Controls whether server-side HTTP 5xx responses (500, 502, 503, 504) gracefully fall back to a previously cached copy instead of presenting an error page to the user.

- `false` (default): HTTP 5xx responses are returned to the client as-is (standard Workbox behavior), ensuring developers and monitoring tools observe backend outages directly.
- `true`: When a backend server errors or crashes with a 5xx status code, NLPWA checks the runtime or offline cache. If a cached copy exists, it serves the cached response instead of a broken page.

```js
// Gracefully serve cached articles if backend API or CMS gateway returns 502/503
{ match: '/articles/**', strategy: 'network-first', fallbackOn5xx: true }
```

#### `navigationFallback` / `offlineFallback` · `string` · default: `'/index.html'`

Fallback HTML document served for navigation requests (`mode: 'navigate'`) when offline or when a navigation misses in the cache. Can be configured per-route or globally in top-level config. Especially useful for multi-page applications (MPAs) or sub-apps with separate offline shells (e.g., an `/admin/` portal falling back to `/admin/index.html` instead of the root `/index.html`).

```js
// Per-route navigation fallback:
{ match: '/admin/**', strategy: 'network-first', navigationFallback: '/admin/index.html' }
```

#### `strategy` — Fetch strategy

| Value                      | Description                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `'cache-first'`            | Cache → Network. Best for: static assets, CDN libraries                                   |
| `'network-first'`          | Network → Cache fallback. Best for: HTML pages                                            |
| `'network-only'`           | Network always. Best for: API writes                                                      |
| `'stale-while-revalidate'` | Cache instantly, update in background. Best for: feeds                                    |
| `'cache-only'`             | Cache only, 503 on miss (or throws if `throwOnFailure: true`). Best for: offline fallback |

See [STRATEGIES.md](STRATEGIES.md) for full strategy behaviour.

---

### `navigationFallback` / `offlineFallback` · `string` · default: `'/index.html'`

Global default fallback document served for unhandled offline page navigations.

```js
navigationFallback: '/index.html'
```

---

### `updateTimeoutMs` · `number` · default: `15000` (version check) / `30000` (manifest check)

Timeout in milliseconds for network requests to update check endpoints (`/api/update/version.json` and `/api/update/info.json`). Can also be set via `updateAPI.timeoutMs`. Useful for tuning timeout sensitivity on slow edge networks or intermittent mobile connections.

```js
updateTimeoutMs: 10000 // 10-second timeout
```

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

### `retainPreviousVersionCache` · `boolean` · default: `true`

Controls whether the immediate prior version's (`v(N-1)`) offline cache is preserved when an update commits.

- `false`: Immediately prunes the old offline cache on commit to conserve storage quota.
- `true` (default): Keeps the immediate prior version's cache in storage alongside the new version. `getFromOffline` falls back to the retained cache if an asset misses in the active cache.

> [!IMPORTANT]
> **Hashed Filenames Required for Chunk 404 Prevention:**
> The previous cache is **only consulted on a cache miss** in the active cache.
> With unhashed filenames (e.g. `/app.js`), open tabs receive the new version immediately because the URL matches in the active cache.
> Furthermore, only one previous generation (`v(N-1)`) is retained; after two updates, older caches are purged. Emitting **content-hashed dynamic chunk filenames** (`chunk-[hash].js`) via your bundler (Vite, Rollup, Webpack) is the essential foundation for preventing chunk 404s.

```js
retainPreviousVersionCache: true
```

---

### `cacheOpaque` · `boolean` · default: `false`

Controls whether opaque cross-origin responses (`type === 'opaque'`, `status === 0` from `no-cors` requests like cross-origin CDNs, web fonts, or unauthenticated scripts) are cached in the runtime cache.

- `false` (default): Opaque responses pass through without being written to CacheStorage. This prevents Chromium browsers from inflating quota by **~7 MB per opaque entry** (padding against size-leak side-channel attacks) and avoids caching undetected CDN 404/500 error pages.
- `true`: Allows caching opaque responses. Can be configured globally in config or selectively per route (`{ match: 'https://cdn.example.com/**', strategy: 'cache-first', cacheOpaque: true }`).

```js
cacheOpaque: false // or true on specific CDN routes
```

---

### `logLevel` · `'silent' | 'error' | 'warn' | 'info' | 'debug'` · default: `'info'`

Controls the verbosity of `[NLPWA]` messages emitted by the Service Worker and shared libraries:

- `'silent'`: Suppresses all console output.
- `'error'`: Logs only fatal and unrecoverable errors.
- `'warn'`: Logs warnings, hash mismatches, and staging retry attempts.
- `'info'` (default): Logs version switches, cache staging results, and cleanup milestones.
- `'debug'`: Logs verbose operational details including per-file staging progress and lock acquisitions.

```js
logLevel: 'info'
```

---

### `offlineFallback` & `navigationFallback` · `string` · default: `'/index.html'`

Fallback URL returned for navigation requests when the user is offline and no cached copy of the requested page is available.
Can be defined globally in `config.js` or per-route in `routes`:

```js
// Global fallback
offlineFallback: '/offline.html'

// Or per-route fallback
routes: [
  { match: '/dashboard/**', strategy: 'network-first', offlineFallback: '/dashboard-offline.html' },
]
```

*(Note: `navigationFallback` is supported as an alias for backwards compatibility).*

---

### `networkTimeoutMs` · `number` · default: `undefined`

Timeout in milliseconds for `network-first` requests.
If the network response is not received within this window and a cached response exists, the cached version is served immediately while the background network fetch completes to update the cache.

```js
// Serve cached page if network takes longer than 2.5s
{ match: '/pages/**', strategy: 'network-first', networkTimeoutMs: 2500 }
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

### `navigationPreload` · `boolean | string` · default: `false`

Enables browser [Navigation Preload](https://developer.mozilla.org/en-US/docs/Web/API/NavigationPreloadManager) (`self.registration.navigationPreload.enable()`).

When enabled, the browser initiates the network request for HTML document navigation in parallel with the Service Worker booting up. This completely eliminates SW startup latency on `network-first` navigations:
- `true`: Enables navigation preload.
- `string`: Enables navigation preload and sets a custom header value (`Service-Worker-Navigation-Preload: <string>`).
- `false`: Disables navigation preload.

```js
navigationPreload: true
```

---

### `navigationAllowlist` & `navigationDenylist` · `Array<string | RegExp | Function>` · default: `[]`

Defines URL pattern boundaries for SPA shell fallback. By default, an offline SPA fallback (e.g. `/index.html`) serves when a navigation request fails. However, navigations to server-rendered portals, admin consoles, or API endpoints should return genuine network errors (503) rather than the client-side SPA bundle.

- `navigationDenylist`: Patterns that **must never** receive the offline SPA fallback. Any failed navigation matching the denylist returns an offline error (503 or throws if `throwOnFailure: true`).
- `navigationAllowlist`: If non-empty, **only** matching navigations receive the SPA fallback.

Supports glob syntax (`/api/**`, `/admin/**`), regular expressions, or custom predicate functions:

```js
navigationDenylist: [
  '/api/**',
  '/admin/**',
  /^\/auth\//,
  ({ url }) => url.pathname.endsWith('.pdf'),
],
navigationAllowlist: [
  '/app/**',
  '/dashboard',
]
```

---

### Range Request Support (HTTP 206 Partial Content)

When cached audio or video is requested (such as in HTML5 `<audio>` or `<video>` elements), browsers like **Safari (iOS & macOS)** send HTTP byte range headers (e.g. `Range: bytes=0-1` or `Range: bytes=1048576-`).

Standard Service Worker caches store full 200 responses. Without range handling, Safari media playback fails or stutters. NLPWA automatically parses RFC 7233 byte ranges on cached responses, constructing valid **206 Partial Content** slices with proper `Content-Range`, `Content-Length`, and `Accept-Ranges: bytes` headers (or 416 if unsatisfiable), enabling native media seeking and smooth playback across all platforms.

---

### Cache Key Control

Fine-tune URL normalization and cache lookups to prevent query fragmentation and ensure clean URL routing.

#### `ignoreURLParametersMatching` · `Array<RegExp | string>`
Strips tracking and analytics parameters from request URLs before caching or matching in runtime cache. Stops marketing campaigns (`?utm_source=twitter&utm_medium=social`, `?fbclid=...`, `?gclid=...`) from fragmenting your cache entries.

Defaults to stripping: `^utm_`, `^fbclid$`, `^gclid$`, `^msclkid$`, `^_ga$`, `^_gl$`, `^mc_eid$`, `^yclid$`.

```js
ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^ref$/]
```

#### `directoryIndex` · `string` · default: `'index.html'`
Maps root and subdirectory requests ending with a trailing slash to their index file (e.g. `/docs/` → `/docs/index.html`).

#### `cleanURLs` · `boolean` · default: `true`
Automatically resolves extensionless paths to their `.html` counterparts (e.g. `/about` → `/about.html`).

---

### Plugin Lifecycle Hooks (`plugins`)

Workbox-style lifecycle plugin hooks allow developers to customize cache storage and request lifecycles without forking the engine. Hooks can be passed via `plugins: [plugin, ...]` or declared directly on routes / global config.

```js
// Example: Custom Auth & Cache Invalidation Plugin
const authAndExpiryPlugin = {
  // 1. requestWillFetch: Attach auth token before network fetch
  async requestWillFetch({ request }) {
    const headers = new Headers(request.headers);
    headers.set('Authorization', 'Bearer ' + getStoredToken());
    return new Request(request.url, { headers });
  },

  // 2. cachedResponseWillBeUsed: Invalidate expired or revoked tokens in cache
  async cachedResponseWillBeUsed({ cachedResponse }) {
    if (!cachedResponse) return null;
    const expiresHeader = cachedResponse.headers.get('X-Token-Expires');
    if (expiresHeader && Date.now() > Number(expiresHeader)) {
      return null; // Treated as cache miss -> re-fetches from network
    }
    return cachedResponse;
  },

  // 3. cacheWillUpdate: Only cache successful JSON payloads
  async cacheWillUpdate({ response }) {
    if (response.status === 200 && response.headers.get('content-type')?.includes('application/json')) {
      return response;
    }
    return null; // Do not store error bodies or non-JSON responses
  },
};
```

#### Available Lifecycle Hooks

| Hook | Parameters | Description |
|---|---|---|
| `requestWillFetch` | `{ request, event, options }` | Called before a network fetch is made. Can return a modified `Request`. |
| `cachedResponseWillBeUsed` | `{ cacheName, request, matchOptions, cachedResponse, event, options }` | Called before a cached response is served. Return a modified `Response`, or `null` to treat as a cache miss. |
| `cacheWillUpdate` | `{ request, response, event, cacheName, options }` | Called before a response is committed to cache. Return modified `Response`, or `null`/`false` to skip caching. |
| `fetchDidSucceed` | `{ request, response, event, options }` | Called after a network fetch succeeds. |
| `fetchDidFail` | `{ error, originalRequest, request, event, options }` | Called when a network fetch throws or goes offline. |
| `cacheDidUpdate` | `{ cacheName, request, oldResponse, newResponse, event, options }` | Called after a response is committed to CacheStorage. |

#### Usage Examples

```js
// Per-route configuration
{
  match: '/api/**',
  strategy: 'network-first',
  plugins: [authAndExpiryPlugin],
}

// Direct hook shortcut on a route
{
  match: '/ephemeral/**',
  strategy: 'cache-first',
  cacheWillUpdate: async ({ response }) => {
    return response.headers.has('X-Cache-Permitted') ? response : null;
  },
}

// Global plugins applied to all routes
export default {
  plugins: [globalTelemetryPlugin],
  routes: [...],
};
```

#### Official Plugins: Background Sync (`nlpwa/sync`)

```js
import { BackgroundSyncPlugin } from 'nlpwa/sync';

export default {
  routes: [
    // Queue offline POST/PUT/PATCH mutations and replay when online
    {
      match: '/api/checkout/**',
      strategy: 'network-only',
      plugins: [
        new BackgroundSyncPlugin({
          queueName: 'orders',
          maxRetentionMs: 24 * 60 * 60 * 1000, // 24h
          maxRetries: 5,
        }),
      ],
    },
  ],
};
```

---

## Full Example

### `sw.js` (Service Worker Engine)

```js
import { initSW } from 'nlpwa/sw';

initSW({
  // SW engine logic version — managed manually by the developer
  version: '1',

  // Path to runtime config file (read from and stored in offline cache)
  configPath: '/api/update/config.json',
});
```

### `nlpwa.config.js` (Application Configuration)

```js
export default {
  // ── Identity ───────────────────────────────────────────────────────────────
  version: '2.1.0',

  // ── Update ─────────────────────────────────────────────────────────────────
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },
  verifyHashes: 'warn',                        // 'strict' | 'warn' | false

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
