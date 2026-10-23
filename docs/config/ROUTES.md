# Configuration Reference — Routes & Caching Strategies

Rules in `nlpwa.config.js` defining URL matching, fetch strategies, cross-origin CDN assets, fallbacks, and lifecycle plugins.

---

## The Non-Overridable App Shell Rule

> [!IMPORTANT]
> **Precached Files Are Strictly Cache-First:**
> All files listed in `precache` (your HTML shell, JS bundles, CSS, and icons) are **automatically served `cache-first` directly from the active offline cache** via an internal, non-overridable rule evaluated before `routes`.
>
> Even if a route defines `{ match: '/app.js', strategy: 'network-first' }`, the precache atomicity rule takes precedence to prevent mixed-version skew. To deploy updates to precached assets, run `nlpwa update`.

---

## Defining Routes

Routes are evaluated **top-to-bottom**; the first matching rule wins:

```javascript
export default {
  routes: [
    { match: '/api/**',         strategy: 'network-only'           },
    { match: '/assets/**',      strategy: 'cache-first'            },
    { match: '/pages/**',       strategy: 'network-first'          },
    { match: '/_feeds/**',      strategy: 'stale-while-revalidate' },
    { match: '/offline.html',   strategy: 'cache-only'             },
    { match: '**',              strategy: 'network-first'          },
  ],
  defaultStrategy: 'network-first',
};
```

---

## URLPattern Syntax & Parameter Extraction

NLPWA uses native browser **`URLPattern`** for route matching. Extracted parameters are automatically populated in `match.params` and passed to plugins and custom handlers.

```javascript
export default {
  routes: [
    // Named parameters (extracted to { id: '...' })
    { match: '/api/v1/users/:id', strategy: 'network-first' },

    // Wildcards (* matches across segments)
    { match: '/assets/*', strategy: 'cache-first' },

    // Regex-constrained parameters
    { match: '/posts/:id(\\d+)', strategy: 'cache-first' },

    // Query parameter matching
    { match: { pathname: '/search', search: 'q=:query' }, strategy: 'network-only' },

    // Cross-origin with origin property
    { match: '/libs/*', origin: 'https://cdn.example.com', strategy: 'cache-first' },

    // Pre-compiled URLPattern instance
    { pattern: new URLPattern({ pathname: '/articles/:slug' }), strategy: 'stale-while-revalidate' },
  ],
};
```

| Pattern Type | Syntax | Extracted Parameters (`params`) | Example URL |
|---|---|---|---|
| Named parameter | `/users/:id` | `{ id: '42' }` | `/users/42` |
| Multiple parameters | `/api/:version/:resource/:id` | `{ version: 'v1', resource: 'items', id: '10' }` | `/api/v1/items/10` |
| Wildcard | `/assets/*` | `{ '0': 'css/main.css' }` | `/assets/css/main.css` |
| Regex group | `/posts/:id(\\d+)` | `{ id: '123' }` | `/posts/123` (skips non-digits) |
| Search params | `{ pathname: '/search', search: 'q=:q' }` | `{ q: 'nlpwa' }` | `/search?q=nlpwa` |
| Cross-origin | `https://cdn.example.com/*` | `{ '0': 'app.js' }` | `https://cdn.example.com/app.js` |
| All paths | `*` | `{ '0': '...' }` | Matches everything |

---

## Fetch Strategies Summary

| Strategy | Description | Best For |
|---|---|---|
| `'cache-first'` | Cache $\rightarrow$ Network | Fingerprinted assets, CDN libraries, fonts |
| `'network-first'` | Network $\rightarrow$ Cache fallback | HTML documents, dynamic pages |
| `'stale-while-revalidate'` | Cache instantly, update in background | Social feeds, listings, dashboards |
| `'network-only'` | Network always, never cached | Authenticated APIs, mutations |
| `'cache-only'` | Cache only, fails if missing | Offline fallback documents |

*See [STRATEGIES.md](../STRATEGIES.md) for in-depth lifecycle diagrams of each strategy.*

---

## Route-Level Options

### `maxAge` · `string | number`
Maximum time a runtime cache entry remains valid before being considered stale. Supports `'7d'`, `'24h'`, `'30m'`, or milliseconds.
```javascript
{ match: '/assets/**', strategy: 'cache-first', maxAge: '7d' }
```

### `networkTimeoutMs` · `number`
Timeout in milliseconds for `network-first` requests before falling back to cached response:
```javascript
{ match: '/pages/**', strategy: 'network-first', networkTimeoutMs: 2500 }
```

### `throwOnFailure` · `boolean` · default: `false`
When `true`, failed network fetches re-throw `TypeError: Failed to fetch` instead of returning a synthetic 503 response, allowing client code (TanStack Query, Axios, SWR) to detect offline states.

### `fallbackOn5xx` · `boolean` · default: `false`
When `true`, backend 5xx errors (500, 502, 503) gracefully serve the cached response instead of an error page.

### `navigationFallback` / `offlineFallback` · `string`
Fallback HTML document served when an offline navigation misses the cache:
```javascript
{ match: '/admin/**', strategy: 'network-first', navigationFallback: '/admin/index.html' }
```

> [!NOTE]
> Custom CacheStorage bucket names (`runtime`, `offline`, `meta`) are configured globally at the top level in `nlpwa.config.js` via the `caches` property.

---

## Cross-Origin & CDN Asset Rules

```javascript
// Method A: Full URL match
{
  match: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/**',
  strategy: 'cache-first',
}

// Method B: Explicit origin + path match
{
  origin: 'https://fonts.googleapis.com',
  match: '/**',
  strategy: 'stale-while-revalidate',
}
```

---

## Cache Key Control & Clean URLs

### `cleanURLs` · `boolean` · default: `true`
Resolves extensionless paths to their `.html` counterpart (e.g. `/about` $\rightarrow$ `/about.html`).

### `directoryIndex` · `string` · default: `'index.html'`
Maps trailing slash requests (e.g. `/docs/` $\rightarrow$ `/docs/index.html`).

### `ignoreURLParametersMatching` · `Array<RegExp>`
Strips tracking query parameters (e.g. `utm_source`, `fbclid`, `gclid`) before cache lookups to eliminate cache fragmentation.
