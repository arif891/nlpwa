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

#### 5. Dead-Letter Store Inspection & Recovery

When a mutation fails with an unrecoverable client error (e.g. `409 Conflict`, `422 Unprocessable Entity`) or exceeds `maxRetries`, NLPWA does **not** silently delete the user's data. Instead, the mutation is moved to the **dead-letter store** for application inspection and manual resolution:

```javascript
// Query permanently failed mutations
const { items } = await syncClient.getDeadLetter('form-mutations');
for (const failedItem of items) {
  console.warn(`Failed mutation: ${failedItem.url}`, failedItem.deadLetterReason, failedItem.lastStatus);
}

// Allow user or app to retry a resolved dead-letter item:
await syncClient.retryDeadLetter(failedItem.id, 'form-mutations');

// Or clear resolved dead-letter entries:
await syncClient.clearDeadLetter('form-mutations');
```

---

### Security Best Practices & Clear-On-Logout

> [!WARNING]
> **Plaintext Storage Notice:** Queued offline requests—including request bodies and request headers such as `Authorization: Bearer <token>` or session cookies—are persisted in browser IndexedDB (`sync_requests`) for up to `maxRetentionMs` (default 24 hours).
> 
> On shared devices or multi-user terminals, you **must** clear the offline mutation queue when the user logs out:

```javascript
// In your application's logout / sign-out handler:
async function handleUserLogout() {
  // Purge all queued offline mutations and sensitive auth tokens across all queues
  await syncClient.clearOnLogout();
  
  // Proceed with normal server logout and token revocation
  await authService.logout();
}
```

### Cross-Browser Compatibility & Fallbacks

| Feature | Chromium (Chrome, Edge) | Safari / iOS WebKit | Mozilla Firefox |
|---|---|---|---|
| **Queue Storage** | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) |
| **Native Background Sync** | ✅ Native `SyncManager` | ❌ Not supported | ❌ Not supported |
| **Window Auto-Sync Replay** | Supported | ✅ Supported via `autoSyncOnOnline()` | ✅ Supported via `autoSyncOnOnline()` |
| **Manual Replay (`syncClient.replay()`)** | ✅ Supported | ✅ Supported | ✅ Supported |

---

## Official Modular Plugins

NLPWA provides additional zero-dependency official plugins that can be imported individually to keep bundle sizes minimal:

### 1. Web Share Target (`nlpwa/share`)

Captures incoming shares from native apps and mobile share sheets into an offline FIFO queue.

```javascript
// In sw.js:
import { initSW } from 'nlpwa/sw';
import { ShareTargetPlugin } from 'nlpwa/share';

initSW({
  plugins: [
    new ShareTargetPlugin({
      action: '/_share-target',
      redirectUrl: '/?shared=1',
      maxPayloadBytes: 25 * 1024 * 1024,
    }),
  ],
});
```

```javascript
// In client.js:
import { onShareTarget, getSharedData } from 'nlpwa/share';

onShareTarget((shared) => {
  console.log('Received shared content:', shared.title, shared.files);
});
```

---

### 2. OS App Badging (`nlpwa/badge`)

Controls the app icon badge count across Windows, macOS, Android, and iOS, with automatic clearance on push notification clicks.

```javascript
// In sw.js:
import { BadgePlugin } from 'nlpwa/badge';

initSW({
  plugins: [new BadgePlugin({ clearOnClick: true })],
});
```

```javascript
// In client.js:
import { setBadge, clearBadge } from 'nlpwa/badge';

await setBadge(5); // Set unread counter to 5
await clearBadge(); // Clear counter
```

---

### 3. Background Fetch (`nlpwa/bg-fetch`)

Manages large file downloads (podcasts, videos, ML weights, asset packs) and uploads in the background with native OS download indicators, progress tracking, and resilient offline persistence.

Available as:
- Service Worker module: `nlpwa/bg-fetch` or `nlpwa/bg-fetch/sw`
- Client SDK module: `nlpwa/bg-fetch/client`
- Pre-bundled scripts: `/plugins/bg-fetch.sw.js` and `/plugins/bg-fetch.client.js`

#### Service Worker Setup

```javascript
// In sw.js:
import { initSW } from 'nlpwa/sw';
import { BackgroundFetchPlugin } from 'nlpwa/bg-fetch';

initSW({
  plugins: [
    new BackgroundFetchPlugin({
      // Default cache target for downloaded assets (defaults to 'runtime')
      cacheName: 'runtime',
      // URL to open or focus when the OS tray notification is clicked
      clickUrl: '/downloads',
      // Optional OS notification titles & icons
      successTitle: 'Download complete',
      failTitle: 'Transfer failed',
    }),
  ],
});
```

#### How the SW Handles Background Fetch Events

1. **Intelligent Cache Target Resolution**:
   - Manifest/precache assets resolve to the active offline cache (`offline@<version>`).
   - URLs matching custom route rules in `config.routes` resolve to that route's designated `cacheName`.
   - All other downloads route to `'runtime'` (or the plugin's `cacheName` option).
2. **IndexedDB Delegation (>25 MB)**:
   - File size is detected via the `Content-Length` header (with fallback to `clone().blob().size` for chunked/CORS responses).
   - If the file exceeds `largeFileThresholdBytes` (default: 25 MB), it is automatically stored in IndexedDB (`nlpwa-large-assets`) while registering in the cache to avoid CacheStorage memory limits.
3. **Native Upload Support**:
   - Non-GET requests (e.g. `POST`, `PUT`) bypass `cache.put()` to prevent CacheStorage method exceptions. The server response is parsed and dispatched directly to client windows.
4. **Native OS Notifications (`BackgroundFetchUpdateUIEvent`)**:
   - `event.updateUI()` is automatically called on completion and failure to present native OS tray feedback with title, icons, and error reasons.
5. **OTA Staging Integration**:
   - During OTA updates, any file larger than `largeFileThresholdBytes` is automatically fetched via Background Fetch using a deterministic escaped URL ID: `nlpwa-bg:${encodeURIComponent(path)}`.
   - If an existing task is already running for that asset, the staging engine reuses it instead of creating duplicates.

#### Client SDK Usage

```javascript
import { backgroundFetchClient, getBgFetchIdForUrl } from 'nlpwa/bg-fetch/client';

// 1. Check browser support
if (backgroundFetchClient.isSupported()) {
  console.log('Background Fetch is supported!');
}

// 2. Start a single-file download (auto-generates deterministic URL-based ID)
const download = await backgroundFetchClient.fetch('/models/large-model.onnx', {
  title: 'Downloading Neural Network Model',
  icons: [{ src: '/icons/model.png', sizes: '192x192' }],
  // Automatically detects downloadTotal via HEAD request if omitted
  onProgress: ({ percent, downloaded, downloadTotal }) => {
    console.log(`Progress: ${percent}% (${downloaded}/${downloadTotal} bytes)`);
  },
});

// 3. Start a multi-file batch download with a custom ID
const albumDownload = await backgroundFetchClient.fetch(
  'album-stellar-voyage',
  ['/audio/track1.mp3', '/audio/track2.mp3', '/audio/track3.mp3', '/audio/cover.jpg'],
  {
    title: 'Downloading "Stellar Voyage"',
    onProgress: ({ percent }) => updateProgressBar(percent),
  }
);

// 4. Look up an active download by URL from any view or open tab
const activeTask = await backgroundFetchClient.getForUrl('/models/large-model.onnx');
if (activeTask) {
  // Subscribe to live progress on the existing task
  const unsubscribe = backgroundFetchClient.onProgress(activeTask, (progress) => {
    renderProgressBar(progress.percent);
  });
}

// 5. Background Upload
const upload = await backgroundFetchClient.fetch('diagnostic-logs-upload', [
  new Request('/api/logs/upload', {
    method: 'POST',
    body: logBlob,
    headers: { 'Content-Type': 'application/json' },
  }),
], {
  title: 'Uploading telemetry logs',
});

// 6. Listen for global completion / failure broadcasts
backgroundFetchClient.onSuccess(({ id, count, cacheName, isUpload, uploadResults }) => {
  console.log(`Task ${id} completed! Stored ${count} files in cache ${cacheName}.`);
  if (isUpload) {
    console.log('Server response:', uploadResults);
  }
});

backgroundFetchClient.onFail(({ id, failureReason }) => {
  console.error(`Task ${id} failed: ${failureReason}`);
});
```

---

### 4. Cryptographic Verification (`nlpwa/crypto`)

Shared Web Crypto utilities for detached Ed25519 signature verification:

```javascript
import { verifyManifestSignature, canonicalizeManifest } from 'nlpwa/crypto';

const isValid = await verifyManifestSignature(manifest, signature, publicKey);
```

