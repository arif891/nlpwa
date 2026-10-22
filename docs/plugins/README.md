# NLPWA — Plugin System & Extensions

NLPWA features a modular, zero-dependency plugin architecture. You can attach plugins to specific route definitions to intercept request and response lifecycles, or use official extensions for offline mutations, background transfers, native OS integration, and cryptographic security.

---

## Table of Contents

- [Plugin Lifecycle Hooks](#plugin-lifecycle-hooks)
- [Writing a Custom Plugin](#writing-a-custom-plugin)
  - [Example: Header Injection Plugin](#example-header-injection-plugin)
  - [Attaching to Routes](#attaching-to-routes)
- [Official Modular Plugins](#official-modular-plugins)
  - [1. Background Sync (`nlpwa/sync`)](SYNC.md)
  - [2. Background Fetch (`nlpwa/bg-fetch`)](BG-FETCH.md)
  - [3. Web Share Target (`nlpwa/share`)](SHARE.md)
  - [4. OS App Badging (`nlpwa/badge`)](BADGE.md)
  - [5. Cryptographic Verification (`nlpwa/crypto`)](CRYPTO.md)

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

  // 6. Invoked before cache key generation (customizes lookup/storage URL)
  async cacheKeyWillBeUsed({ request, mode }) {
    // Return custom Request or URL string
    return request;
  }

  // 7. Optional Push & Background Sync hooks
  async onPush(event, payload) {
    // Handle incoming Web Push
  }

  async onNotificationClick(event) {
    // Handle notification interaction
  }

  async onPeriodicSync(event) {
    // Handle scheduled background tasks
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

Attach plugins in your `nlpwa.config.js`:

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

## Official Modular Plugins

NLPWA provides zero-dependency, tree-shakeable official plugins:

| Plugin | Export Path | Purpose | Documentation |
|---|---|---|---|
| **Background Sync & Periodic Sync** | `nlpwa/sync`, `nlpwa/sync/periodic` | Offline mutation queueing with FIFO replay, dead-letter store & periodic background tasks | [SYNC.md](SYNC.md) |
| **Web Push** | `nlpwa/push` | Web Push subscription management, VAPID key conversion & action button routing | [PUSH.md](PUSH.md) |
| **Background Fetch** | `nlpwa/bg-fetch` | Large file downloads & uploads with OS progress bars | [BG-FETCH.md](BG-FETCH.md) |
| **Web Share Target** | `nlpwa/share` | Native mobile share sheet receiver with offline file hydration | [SHARE.md](SHARE.md) |
| **OS App Badging** | `nlpwa/badge` | Desktop/mobile app icon badges & push notification clearing | [BADGE.md](BADGE.md) |
| **Cryptographic Verification** | `nlpwa/crypto` | Ed25519 signature signing & Web Crypto manifest verification | [CRYPTO.md](CRYPTO.md) |
