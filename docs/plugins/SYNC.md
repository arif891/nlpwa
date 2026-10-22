# Background Sync Plugin (`nlpwa/sync`)

The `nlpwa/sync` plugin is an official, zero-runtime-dependency extension that queues failed offline mutation requests (`POST`, `PUT`, `PATCH`, `DELETE`) in IndexedDB and replays them in strict FIFO order when the browser regains internet connectivity.

---

## Key Capabilities

- **Zero Dependencies:** Pure IndexedDB implementation (`sync_requests` store) without third-party IDB wrappers.
- **Request Serialization:** Clones and preserves headers, methods, credentials, and bodies (text, JSON, ArrayBuffer, Blob).
- **FIFO Ordering:** Replays queued mutations in the exact order they were submitted.
- **Pruning & Retries:** Configurable `maxRetries` (exponential backoff) and `maxRetentionMs` expiry.
- **Dead-Letter Store:** Permanently failed mutations (e.g. 409 Conflict, 422 Unprocessable Entity) are retained in an isolated store for user inspection rather than dropped silently.
- **Cross-Browser Fallbacks:** Operates with Chromium's native `SyncManager` when available, and automatically falls back to window-side `online` and `visibilitychange` listeners in Safari, iOS, and Firefox.

---

## Installation

### For Bundlers (Vite / Rollup / Webpack)
```bash
npm install nlpwa
```

Subpath exports:
- `nlpwa/sync` (Service Worker bundle)
- `nlpwa/sync/client` (Client SDK bundle)

### For No-Build Static Sites (CLI)
```bash
npx nlpwa add sync --dir ./public
```

Places:
- `public/plugins/sync.sw.js` — IIFE Service Worker script (`window.NLPWASyncSW`).
- `public/plugins/sync.client.js` — IIFE Client script (`window.NLPWASyncClient`).

---

## Service Worker Configuration

Attach `BackgroundSyncPlugin` to your mutation routes in `nlpwa.config.js`:

```javascript
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

---

## Client SDK Usage (`syncClient`)

```javascript
import { syncClient } from 'nlpwa/sync/client';
```

### 1. Enable Auto-Sync on Reconnect (Cross-Browser)

Enables automatic queue replays when the browser triggers the `window.online` event or becomes visible. Essential for Safari and Firefox:

```javascript
syncClient.autoSyncOnOnline('form-mutations');
```

### 2. Query Pending Queue Count

Check if the user has pending offline mutations (useful for badges or offline warnings):

```javascript
const { count, items } = await syncClient.getPending('form-mutations');
console.log(`Pending offline items: ${count}`);

if (count > 0) {
  badge.textContent = `${count} pending sync`;
}
```

### 3. Manually Trigger Replay

Allow users to explicitly trigger a retry (e.g. "Retry Now" button):

```javascript
const result = await syncClient.replay('form-mutations');
console.log(`Replayed ${result.replayed} mutations (${result.remaining} remaining)`);
```

### 4. Event Subscriptions

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

### 5. Dead-Letter Store Inspection & Recovery

When a mutation fails with an unrecoverable client error or exceeds `maxRetries`, NLPWA moves it to the **dead-letter store**:

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

## Security Considerations: Credentials, Token Expiry & Re-attachment

> [!WARNING]
> **Plaintext Storage Notice & Token Expiration:** By default, queued offline requests—including request bodies and request headers such as `Authorization: Bearer <token>` or session headers—are persisted in browser IndexedDB (`sync_requests`) for up to `maxRetentionMs` (default 24 hours).
>
> This introduces two specific considerations:
> 1. **Token Expiration / Invalidation:** Bearer tokens frequently expire before the 24-hour retention window ends. When replayed with an expired token, the server returns 401/403 or redirects to login. NLPWA detects this and sets `authRequired: true`, holding the item safely without discarding the user's offline work.
> 2. **Shared Terminals & Credential Persistence:** On shared devices, storing Authorization headers in IndexedDB exposes tokens to local extraction.

### Mitigation Strategies

#### 1. Strip Auth Headers at Rest (`stripAuthHeaders: true`)
If you prefer not to store credentials in IndexedDB, configure `stripAuthHeaders: true` on your `BackgroundSyncPlugin` or `SyncQueue`. This strips `Authorization` and `Proxy-Authorization` headers before persisting records to IndexedDB:

```javascript
new BackgroundSyncPlugin({
  queueName: 'form-mutations',
  stripAuthHeaders: true, // Strips Authorization headers from IDB storage
})
```

#### 2. Re-attach Fresh Credentials at Replay Time
When replaying requests (either on reconnect or after user re-authentication), pass fresh headers via `replay()` or `retryAuthRequired()`:

```javascript
// Replay with refreshed token
await syncClient.replay('form-mutations', {
  headers: {
    'Authorization': `Bearer ${freshAuthToken}`,
  },
});

// Or re-attach new credentials to authRequired items after login:
await syncClient.retryAuthRequired('form-mutations', item.id, {
  headers: {
    'Authorization': `Bearer ${freshAuthToken}`,
  },
});
```

#### 3. Purge Queues on User Logout (`clearOnLogout()`)
On shared devices or multi-user applications, always clear the offline mutation queue when the user logs out:

```javascript
// In your application's logout / sign-out handler:
async function handleUserLogout() {
  // Purge all queued offline mutations and sensitive auth tokens across all queues
  await syncClient.clearOnLogout();
  
  // Proceed with normal server logout and token revocation
  await authService.logout();
}
```

---

## Cross-Browser Compatibility & Fallbacks

| Feature | Chromium (Chrome, Edge) | Safari / iOS WebKit | Mozilla Firefox |
|---|---|---|---|
| **Queue Storage** | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) | IndexedDB (`sync_requests`) |
| **Native Background Sync** | ✅ Native `SyncManager` | ❌ Not supported | ❌ Not supported |
| **Window Auto-Sync Replay** | Supported | ✅ Supported via `autoSyncOnOnline()` | ✅ Supported via `autoSyncOnOnline()` |
| **Manual Replay (`syncClient.replay()`)** | ✅ Supported | ✅ Supported | ✅ Supported |
