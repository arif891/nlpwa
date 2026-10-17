# NLPWA — Fetch Strategies

NLPWA intercepts every `GET` request from your app and routes it through one
of five strategies based on your route configuration.

Only `GET` requests are intercepted. `POST`, `PUT`, `DELETE`, etc. pass through
directly to the network.

---

## Strategy Overview

| Strategy | Serves from | Network fallback | Caches response | Best for |
|---|---|---|---|---|
| `cache-first` | Offline → Runtime | Yes (on miss) | ✅ Runtime | Static assets |
| `network-first` | Network | Cache (offline → runtime) | ✅ Runtime | HTML, user data |
| `network-only` | Network | ❌ None | ❌ Never | API mutations |
| `stale-while-revalidate` | Cache (instant) | Blocks if no cache | ✅ Runtime | Feeds, listings |
| `cache-only` | Cache | 503 response | ❌ Never | Offline fallback |

### `X-Cache-Status` Headers

Every response intercepted by NLPWA includes an `X-Cache-Status` response header for debugging and observability:

| Header Value | Meaning |
|---|---|
| `offline-cache` | Served from the active versioned offline cache (`precache` + `config.json`) |
| `runtime-cache` | Served from the dynamic runtime cache |
| `network` | Fetched fresh from the network |
| `stale` | Served immediately from cache while revalidating in background |
| `offline-fallback` | Offline fallback served for navigation or cache misses when offline |
| `bypass` | Request bypassed the Service Worker cache |

---

## `cache-first`

```
Request → offline cache → runtime cache → network → store in runtime
```

**Behaviour:**
1. Check `offline` cache (precached app shell)
2. Check `runtime` cache (lazily cached assets)
3. On cache miss: fetch from network, store in `runtime` cache, return response

**Characteristics:**
- Fastest possible response — zero network latency after first cache
- Response is **never revalidated** until an NLPWA update check runs
- Stale files are automatically replaced by the update system when hashes change

**Best for:** Files that are content-hashed and change only on a new deploy:
- JavaScript bundles (`app.abc123.js`)
- CSS files (`styles.def456.css`)
- Images, fonts, icons

**Route example:**
```js
{ match: '/assets/**', strategy: 'cache-first' }
```

---

## `network-first`

```
Request → network (within networkTimeoutMs) → store in runtime → return
                 ↓ (timeout / network fails)
           offline cache → runtime cache → 503 (or navigationFallback)
```

**Behaviour:**
1. Fetch from network.
2. If `networkTimeoutMs` is configured and elapses while a cached response exists, the cached response is served immediately while the network fetch continues in the background to refresh the cache.
3. If no cached response exists, it continues waiting for the network rather than immediately returning 503.
4. On network success: store in `runtime` cache, return response.
5. On network failure: check `offline` then `runtime` cache.
6. If offline with no cache match for navigation requests: falls back to `navigationFallback` if configured. Otherwise returns a `503` text response (never throws).

**Characteristics:**
- Always fresh when online
- Graceful offline fallback using last-cached response
- Optional `networkTimeoutMs` avoids slow-network hanging for users with cached data

**Best for:** Content that must be fresh when online but should still work offline:
- HTML pages (`/`, `/about`, `/dashboard`)
- User profile data
- App entry points

**Route example:**
```js
{ match: '/pages/**', strategy: 'network-first' },
{ match: '**',        strategy: 'network-first' },  // catch-all
```

---

## `network-only`

```
Request → network → return (no caching)
```

**Behaviour:**
1. Always fetch from network
2. Response is never stored in any cache
3. If the network is unavailable, the request fails naturally

**Characteristics:**
- Zero caching overhead
- Response includes auth headers, cookies, CSRF tokens untouched
- Not affected by NLPWA update eviction (nothing is ever cached)

**Best for:** Requests where stale data would be harmful:
- API mutations (`POST /api/orders`, `PUT /api/profile`)
- Authentication endpoints
- Payment processing
- Anything requiring fresh session state

**Route example:**
```js
{ match: '/api/**', strategy: 'network-only' }
```

> **Note:** Even though `network-only` is listed in routes, it is not considered
> a "caching-capable" strategy. Existing cached responses for these URLs are
> evicted during updates.

---

## `stale-while-revalidate`

```
Request → runtime/offline cache → return immediately (stale)
                ↓ (simultaneously, in background)
          network → store in runtime (for next request)
```

**Behaviour:**
1. Serve cached response immediately (zero latency)
2. Simultaneously fetch fresh response from network in the background
3. Store fresh response in `runtime` cache (for the **next** request)
4. If no cache exists: block on network, store and return

**Characteristics:**
- Fastest user-perceived response (immediate from cache)
- Always one request behind — the user sees the cached version, next load is fresh
- Background network failure is silently swallowed (cached version remains)

**Best for:** Content that changes frequently but where slight staleness is acceptable:
- News feeds, social timelines
- Product listings, search results
- Non-critical configuration
- Avatars, thumbnails

**Route example:**
```js
{ match: '/_feeds/**',   strategy: 'stale-while-revalidate' },
{ match: '/listings/**', strategy: 'stale-while-revalidate' },
```

---

## `cache-only`

```
Request → offline cache → runtime cache → 503 response
```

**Behaviour:**
1. Check `offline` cache
2. Check `runtime` cache
3. If not found anywhere: return a `503 Not available offline` text response (never throws)

**Characteristics:**
- Never touches the network
- Only succeeds if the resource was precached or previously cached by another strategy
- Useful as a strategy for resources that must be available offline but never updated

**Best for:**
- Explicit offline fallback pages (`/offline.html`)
- Resources deliberately precached for offline use
- Shell assets that should never be fetched fresh during a session

**Route example:**
```js
{ match: '/offline.html', strategy: 'cache-only' }
```

---

## Cache Lookup Order

All strategies that read from cache follow this priority:

```
1. offline cache    (precached app shell, update-applied files)
2. runtime cache    (lazily cached responses)
```

The `offline` cache takes precedence because it contains files explicitly managed
by the update system, which guarantees they match the current server hashes.

---

## Caching-Capable vs. Network-Only

The distinction matters for **cache eviction**:

| Caching-capable | Not caching-capable |
|---|---|
| `cache-first` | `network-only` |
| `network-first` | |
| `stale-while-revalidate` | |
| `cache-only` | |

During an update, NLPWA evicts any cached entry whose URL matches only
`network-only` routes (or no route at all, using `defaultStrategy`).
This ensures stale API responses don't linger after a route config change.

---

## Choosing a Strategy

```
Is the response user/session-specific or a mutation?
  YES → network-only

Does the file change only when you deploy a new version?
  YES → cache-first  (content-hashed assets, fonts, icons)

Do you need fresh content when online, with offline fallback?
  YES → network-first  (HTML pages, dashboard data)

Is slight staleness acceptable and speed is important?
  YES → stale-while-revalidate  (feeds, listings, thumbnails)

Is this a manual offline fallback that never needs to be fresh?
  YES → cache-only  (offline.html, placeholder pages)
```

---

## Cross-Origin & CDN Asset Caching

NLPWA supports caching cross-origin requests, such as third-party CDNs, Google Fonts, or AI/ML WebAssembly runtimes (e.g., `onnxruntime-web`, TensorFlow.js).

### Configuration Options

You can define cross-origin routes in either style:

```js
// Option 1: Full URL pattern
{ match: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/**', strategy: 'cache-first' }

// Option 2: Origin property + path glob
{ origin: 'https://cdn.jsdelivr.net', match: '/npm/onnxruntime-web@1.30.0/**', strategy: 'cache-first' }

// Option 3: Wildcard origin for all origins matching a path pattern
{ origin: '*', match: '/fonts/**', strategy: 'cache-first' }
```

### Opaque Responses & WASM Binaries
- When assets are loaded via `<script>` tags, Web Workers, or `importScripts` without CORS headers, the browser generates an **opaque response** (`status: 0`, `type: 'opaque'`).
- NLPWA safely stores opaque responses in the `runtime` cache, allowing heavy `.wasm` and `.mjs` worker scripts to load instantaneously offline without throwing Quota or Range errors.
- Any request not matching an explicit cross-origin route automatically passes through via `networkOnly` without caching.

