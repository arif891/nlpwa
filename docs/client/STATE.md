# Client SDK — Reactive State & Diagnostics

Provides a unified reactive state store, multi-boot probation health reporting, boot watchdog recovery, and deep diagnostic inspection.

---

## Unified Reactive State Store: `getState()` & `subscribe()`

NLPWA maintains an internal reactive state store representing the app's Service Worker and update lifecycle:

```javascript
import { nlpwa } from 'nlpwa/client';

// 1. Read current snapshot
const state = nlpwa.getState();
console.log(state);
// {
//   version: '1.2.0',
//   status: 'idle', // 'idle' | 'checking' | 'staging' | 'ready' | 'applying'
//   stagedVersion: null,
//   isLeader: true,
//   isPinned: true,
//   isOnline: true,
//   canInstall: false,
//   isInstalled: false,
//   stagingProgress: null
// }

// 2. Subscribe to reactive changes (e.g. for React, Vue, Svelte, Solid)
const unsubscribe = nlpwa.subscribe((state) => {
  renderUpdateUI(state);
});

// To disconnect:
unsubscribe();
```

---

## Multi-Boot Probation & Boot Watchdog

When a new version commits, it enters a multi-boot probation state. The Service Worker retains the previous known-good version in `nlpwa-fallback` and monitors the boot lifecycle across browser sessions.

- **Error Filtering:** Automatically filters out third-party script crashes (Google Tag Manager, Sentry, ads) and browser extensions (`chrome-extension://`), focusing strictly on first-party application crashes.
- **24-Hour Block Expiration:** Blocked releases on a client automatically expire after 24 hours (configurable via `probation.clientBlockTtlMs`).

### `nlpwa.markHealthy()`

Explicitly confirms that the application has initialized and rendered successfully. Increments healthy boot count and graduates from probation once `requiredHealthyBoots` (default: 2) is reached:

```javascript
import { nlpwa } from 'nlpwa/client';

// Call in your root app component after initial mount/render
async function onAppReady() {
  await nlpwa.markHealthy();
}
```

### `nlpwa.reportBootFailure(error)`

Manually reports a critical initialization failure, notifying the Service Worker to evaluate probation rollback immediately:

```javascript
try {
  await initCoreEngine();
  nlpwa.markHealthy();
} catch (err) {
  nlpwa.reportBootFailure(err);
}
```

---

## Deep Diagnostics: `nlpwa.diagnostics()`

Queries the Service Worker and returns a comprehensive snapshot of cache status, pins, fallbacks, storage quotas, and tab coordination:

```javascript
import { nlpwa } from 'nlpwa/client';

const diag = await nlpwa.diagnostics();
console.log(diag);
// {
//   activeVersion: '1.2.0',
//   pinnedVersion: '1.2.0',
//   isPinned: true,
//   stagedVersion: null,
//   fallbackAvailable: true,
//   blockedVersions: [],
//   channel: 'stable',
//   storage: { usageBytes, quotaBytes, percentUsed },
//   isLeader: true,
//   dirtyState: false
// }
```

### `nlpwa.getPinStatus()`

Inspects the version pinning state of the current tab:

```javascript
const { pinnedVersion, activeVersion, isPinned } = await nlpwa.getPinStatus();
```
