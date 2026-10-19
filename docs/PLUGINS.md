# NLPWA — Plugin System & Extensions

NLPWA features a modular, zero-dependency plugin architecture. You can attach plugins to specific route definitions to intercept request and response lifecycles, or use official extensions like Background Sync for offline mutations.

---

## Table of Contents

- [Plugin Lifecycle Hooks](#plugin-lifecycle-hooks)
- [Writing a Custom Plugin](#writing-a-custom-plugin)
- [Official Plugin: Background Sync (`nlpwa/sync`)](#official-plugin-background-sync-nlpwasync)
  - [Overview](#overview)
  - [Installation (CLI vs. NPM)](#installation-cli-vs-npm)
  - [Service Worker Configuration](#service-worker-configuration)
  - [Client SDK Usage (`syncClient`)](#client-sdk-usage-syncclient)
  - [Cross-Browser Compatibility & Fallbacks](#cross-browser-compatibility--fallbacks)

---

## Plugin Lifecycle Hooks

A plugin is an object (or class instance) implementing one or more async lifecycle hooks:

```javascript
class CustomPlugin {
  // 1. Invoked before a network fetch is initiated
  async requestWillFetch({ request, event }) {
    // Return a modified Request (e.g. inject an auth header) or undefined to keep as-is
    return request;
  }

  // 2. Invoked before a cached response is returned to the client
  async cachedResponseWillBeUsed({ request, cachedResponse, matchPath }) {
    // Return a modified Response or undefined to keep cachedResponse
    return cachedResponse;
  }

  // 3. Invoked before a network response is committed to the cache
  async cacheWillUpdate({ request, response }) {
    // Return true / modified Response to allow caching, or false / null to prevent caching
    return response;
  }

  // 4. Invoked when a network fetch rejects (e.g. device is offline)
  async fetchDidFail({ request, error, event }) {
    // Perform side-effects (e.g. offline queueing, analytics logging)
  }

  // 5. Invoked when a network fetch resolves successfully
  async fetchDidSucceed({ request, response }) {
    // Perform side-effects (e.g. telemetry, latency logging)
  }
}
```

---

## Writing a Custom Plugin

### Example: Header Injection Plugin

A plugin that automatically attaches a custom telemetry or authentication token to outgoing requests for specific routes:

```javascript
// telemetry-plugin.js
export class TelemetryPlugin {
  constructor(appId) {
    this.appId = appId;
  }

  async requestWillFetch({ request }) {
    const headers = new Headers(request.headers);
    headers.set('X-Client-App-Id', this.appId);
    headers.set('X-Request-Timestamp', String(Date.now()));

    return new Request(request, { headers });
  }

  async fetchDidSucceed({ request, response }) {
    console.log(`[Telemetry] ${request.method} ${request.url} → ${response.status}`);
  }
}
```

### Attaching to Routes

Attach plugins in your `config.js`:

```javascript
import { TelemetryPlugin } from './telemetry-plugin.js';

export default {
  routes: [
    {
      match: '/api/**',
      strategy: 'network-only',
      plugins: [
        new TelemetryPlugin('my-pwa-app-123'),
      ],
    },
  ],
};
```

---

## Official Plugin: Background Sync (`nlpwa/sync`)

### Overview

`nlpwa/sync` is an official, zero-runtime-dependency extension that queues failed offline mutation requests (`POST`, `PUT`, `PATCH`, `DELETE`) in IndexedDB and replays them in strict FIFO order when the browser regains internet connectivity.

Key capabilities:
- **Zero Dependencies:** Pure IndexedDB implementation (`sync_requests` store) without heavy third-party IDB wrappers.
- **Request Serialization:** Clones and preserves headers, methods, credentials, and bodies (text, JSON, ArrayBuffer, Blob).
- **FIFO Ordering:** Replays queued mutations in the exact order they were submitted.
- **Pruning & Retries:** Configurable `maxRetries` (exponential backoff) and `maxRetentionMs` expiry.
- **Cross-Browser Fallbacks:** Operates with Chromium's native `SyncManager` when available, and automatically falls back to window-side `online` and `visibilitychange` listeners in Safari, iOS, and Firefox.

---

### Installation (CLI vs. NPM)

#### Option A: For No-Build / Static Sites (CLI)

Use the CLI to drop pre-bundled standalone plugins into your project:

```bash
npx nlpwa add sync --dir ./public
```

This places:
- `public/plugins/sync.sw.js` — Standalone IIFE Service Worker script (`window.NLPWASyncSW`).
- `public/plugins/sync.client.js` — Standalone IIFE Client script (`window.NLPWASyncClient`).

#### Option B: For Bundlers & NPM Projects

```bash
npm install nlpwa
```

Import subpath exports directly:
- `nlpwa/sync` (Service Worker bundle)
- `nlpwa/sync/client` (Client SDK bundle)

---

### Service Worker Configuration

Attach `BackgroundSyncPlugin` to your mutation routes:

#### With Bundlers (Vite / Rollup)

```javascript
// config.js
import { BackgroundSyncPlugin } from 'nlpwa/sync';

export default {
  routes: [
    {
      match: '/api/mutations/**',
      strategy: 'network-only',
      plugins: [
        new BackgroundSyncPlugin({
          queueName: 'form-mutations',
          maxRetentionMs: 24 * 60 * 60 * 1000, // Keep in queue for up to 24 hours
          maxRetries: 5,                       // Abandon after 5 failed attempts
        }),
      ],
    },
  ],
};
```

#### With No-Build Static Drop-in (`sw.js`)

In your root `sw.js`:

```javascript
importScripts('/plugins/sync.sw.js');

const syncPlugin = new NLPWASyncSW.BackgroundSyncPlugin({
  queueName: 'form-mutations',
  maxRetries: 5,
});

// Pass to route definitions
```

---

### Client SDK Usage (`syncClient`)

Interact with the queue, monitor pending mutations, and receive sync status in your web application.

```javascript
// ES Module / Bundler:
import { syncClient } from 'nlpwa/sync/client';

// Or in static HTML:
// <script src="/plugins/sync.client.js"></script>
// const { syncClient } = window.NLPWASyncClient;
```

#### 1. Enable Auto-Sync on Reconnect (Cross-Browser)

Enables automatic queue replays when the browser triggers the `window.online` event or becomes visible. Essential for Safari and Firefox:

```javascript
syncClient.autoSyncOnOnline('form-mutations');
```

#### 2. Query Pending Queue Count

Check if the user has pending offline mutations (useful for badges or offline warnings):

```javascript
const { count, items } = await syncClient.getPending('form-mutations');
console.log(`Pending offline items: ${count}`);

if (count > 0) {
  badge.textContent = `${count} pending sync`;
}
```

#### 3. Manually Trigger Replay

Allow users to explicitly trigger a retry (e.g. "Retry Now" button):

```javascript
const result = await syncClient.replay('form-mutations');
console.log(`Replayed ${result.replayed} mutations (${result.remaining} remaining)`);
```

#### 4. Event Subscriptions

Subscribe to queue events across your application:

```javascript
// Fired when a queued request replays successfully
syncClient.on('success', ({ url, status, id }) => {
  console.log(`Successfully synced mutation to ${url} (HTTP ${status})`);
});

// Fired when a replay fails
syncClient.on('error', ({ url, error, retryCount }) => {
  console.warn(`Retry failed for ${url} (Attempt ${retryCount}):`, error);
});

// Fired when an item exceeds maxRetries or retention expiry
syncClient.on('discard', ({ url, reason }) => {
  console.error(`Discarded mutation for ${url}: ${reason}`);
});
```

#### 5. Clear Stored Queue

Wipe stored queue entries on user logout:

```javascript
await syncClient.clear('form-mutations');
```

---

### Cross-Browser Compatibility & Fallbacks

| Feature | Chromium (Chrome, Edge) | Safari / iOS WebKit | Mozilla Firefox |
|---|---|---|---|
| **Queue Storage** | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) |
| **Native Background Sync** | ✅ Native `SyncManager` | ❌ Not supported | ❌ Not supported |
| **Window Auto-Sync Replay** | Supported | ✅ Supported via `autoSyncOnOnline()` | ✅ Supported via `autoSyncOnOnline()` |
| **Manual Replay (`syncClient.replay()`)** | ✅ Supported | ✅ Supported | ✅ Supported |
