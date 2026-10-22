# Background Sync Plugin (`nlpwa/sync`)

The `nlpwa/sync` plugin is an official, zero-runtime-dependency extension that queues failed offline mutation requests (`POST`, `PUT`, `PATCH`, `DELETE`) in IndexedDB and replays them in strict FIFO order when the browser regains internet connectivity.

---

## Architecture Overview

```
[ Web Page / App ]              [ Service Worker ]             [ IndexedDB (sync_requests) ]         [ Remote Server ]
       │                               │                                     │                               │
       │── POST /api/mutation ────────>│                                     │                               │
       │                               │── fetch() fails (offline) ─────────>│                               │
       │                               │── serializeRequest() ──────────────>│ (Stored FIFO)                 │
       │<─ 503 Offline / Queued ───────│── emit('enqueued') ────────────────>│                               │
       │                               │                                     │                               │
       │                     [ Network Connectivity Returns ]                │                               │
       │                               │                                     │                               │
       │── syncClient.replay() ───────>│ (or native 'sync' event)            │                               │
       │                               │── replayAll() under Web Lock ───────│                               │
       │                               │   ├── deserializeRequest() ─────────│                               │
       │                               │   └── fetch(req with Idempotency) ──┼──────────────────────────────>│
       │                               │                                     │<── 200 OK / 201 Created ──────│
       │                               │── remove(id) ──────────────────────>│ (Dequeued)                    │
       │<─ emit('success') ────────────│                                     │                               │
```

---

## Key Capabilities

- **Zero Dependencies:** Pure IndexedDB implementation (`sync_requests` store) without third-party IDB wrappers.
- **Request Serialization:** Clones and preserves headers, methods, credentials (`include` / `same-origin`), mode, and bodies (text, JSON, ArrayBuffer, Blob).
- **Automatic Idempotency Key:** Automatically generates and attaches an `X-Idempotency-Key: <UUID>` header (unless already provided) so backend endpoints can safely deduplicate retries.
- **FIFO Ordering & Multi-Tab Locking:** Replays queued mutations in the exact order they were submitted, guarded across browser tabs and workers via the Web Locks API (`navigator.locks`).
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
          maxRetries: 5,                       // Move to dead-letter store after 5 failed attempts
          stripAuthHeaders: false,             // Set true to avoid storing tokens at rest in IDB
        }),
      ],
    },
  ],
};
```

### Offline Fetch Handling in Client UI

When a user submits a mutation while offline:
- In **NLPWA Core** (`strategy: 'network-only'`), the Service Worker intercepts the failed network call, enqueues the request in IndexedDB, and returns a synthetic HTTP `503 Service Unavailable` (`Offline — network request failed.`).
- In your application, `await fetch(...)` does **not** reject with an unhandled exception—it resolves with `response.ok === false` and `response.status === 503`. You can handle this gracefully to show an "Offline — saved to sync outbox" confirmation:

```javascript
const res = await fetch('/api/mutations/order', { method: 'POST', body });
if (res.status === 503) {
  showToast('Offline: Order queued. It will submit automatically when reconnected.');
}
```

---

## Client SDK Usage (`syncClient`)

```javascript
import { syncClient } from 'nlpwa/sync/client';
```

### 1. Enable Auto-Sync on Reconnect (Cross-Browser)

Enables automatic queue replays when the browser triggers the `window.online` event or becomes visible. Essential for Safari and Firefox:

```javascript
// Automatically syncs when network returns or tab is refocused
const cleanup = syncClient.autoSyncOnOnline('form-mutations');
```

Replay operations are safely locked via the Web Locks API, so having multiple tabs or windows open will never trigger duplicate simultaneous requests.

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
console.log(`Replayed ${result.successCount} mutations (${result.remainingCount} remaining)`);
// result.replayed and result.remaining are also available as convenience aliases
```

### 4. Event Subscriptions

Subscribe to queue lifecycle events:

```javascript
// Fired when an offline mutation is captured and persisted to IndexedDB
syncClient.on('enqueued', ({ url, method, id }) => {
  console.log(`Enqueued ${method} ${url} (ID: ${id})`);
});

// Fired when a queued request replays successfully
syncClient.on('success', ({ url, status, id }) => {
  console.log(`Successfully synced mutation to ${url} (HTTP ${status})`);
});

// Fired when a replay attempt fails ('error' and 'failed' are aliases)
syncClient.on('error', ({ url, error }) => {
  console.warn(`Retry failed for ${url}:`, error);
});

// Fired when an item permanently fails (4xx unrecoverable) or exceeds maxRetries
syncClient.on('discard', ({ url, reason, status }) => {
  console.error(`Moved to dead-letter store: ${url} (Reason: ${reason}, HTTP: ${status})`);
});
```

### 5. Dead-Letter Store Inspection & Recovery

When a mutation fails with an unrecoverable client error (409 Conflict, 422 Unprocessable Entity) or exceeds `maxRetries`, NLPWA moves it to the **dead-letter store** rather than dropping it silently:

```javascript
// Query permanently failed mutations
const { items } = await syncClient.getDeadLetter('form-mutations');
for (const failedItem of items) {
  console.warn(`Failed mutation: ${failedItem.url}`, failedItem.deadLetterReason, failedItem.lastStatus);
}

// Allow user or app to retry a resolved dead-letter item (supports both signatures):
await syncClient.retryDeadLetter(failedItem.id, 'form-mutations');
// or: await syncClient.retryDeadLetter('form-mutations', failedItem.id);

// Or clear resolved dead-letter entries:
await syncClient.clearDeadLetter('form-mutations');
```

---

## Idempotency Key Specification (`X-Idempotency-Key`)

To protect against duplicate server-side side effects during network reconnects or retry replays:
1. NLPWA inspects outgoing requests for an `Idempotency-Key` or `X-Idempotency-Key` header.
2. If none is present, `serializeRequest` generates a unique UUID (e.g. `nlpwa-1729583400-abc1234` or native `crypto.randomUUID()`) and saves it with the request record.
3. Upon replay, `deserializeRequest` attaches `X-Idempotency-Key: <UUID>`.
4. Your server can inspect this header to identify and deduplicate retried mutations.

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
// Replay all pending with refreshed token
await syncClient.replay('form-mutations', {
  headers: {
    'Authorization': `Bearer ${freshAuthToken}`,
  },
});

// Or re-attach new credentials to authRequired items after login (flexible parameter order):
await syncClient.retryAuthRequired(item.id, 'form-mutations', {
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
| **Multi-Tab Concurrency Guard** | ✅ Web Locks (`navigator.locks`) | ✅ Web Locks (`navigator.locks`) | ✅ Web Locks (`navigator.locks`) |
