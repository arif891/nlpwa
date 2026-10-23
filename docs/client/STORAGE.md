# Client SDK — Storage Quotas & Cleanup

Monitors device storage quotas, manages persistent storage permissions, and provides on-demand runtime cache cleanup.

---

## 1. Storage Quotas: `getCacheInfo()`

Queries the Service Worker and `navigator.storage.estimate()` to inspect origin disk usage and runtime cache size:

```javascript
import { nlpwa } from 'nlpwa/client';

const info = await nlpwa.getCacheInfo();
// {
//   quota: 107374182400,
//   usage: 52428800,
//   percentUsed: 0.05,
//   remaining: 107321753600,
//   runtimeEntries: 42,
//   runtimeBytes: 15728640,
//   largestEntries: [ ... ]
// }
console.log(`Used: ${(info.usage / 1e6).toFixed(1)} MB of ${(info.quota / 1e6).toFixed(1)} MB (${info.percentUsed}%)`);
```

---

## 2. Persistent Storage: `isStoragePersistent()` & `requestPersistentStorage()`

Protects offline data from automatic browser eviction under disk pressure:

```javascript
import { nlpwa } from 'nlpwa/client';

// Check if storage is already persistent
const isPersistent = await nlpwa.isStoragePersistent();

if (!isPersistent) {
  // Request persistence upon user action (e.g. clicking "Save for Offline")
  const granted = await nlpwa.requestPersistentStorage();
  console.log('Persistence granted:', granted);
}
```

> [!TIP]
> **Best Practice:** Call `requestPersistentStorage()` after user gestures (e.g. clicking an "Offline Mode" toggle or following PWA installation) rather than automatically on page load to ensure higher browser grant rates.

---

## 3. Runtime Cache Cleanup: `cleanupRuntimeCache(options)`

Triggers an on-demand cleanup of the runtime cache using LRU (least-recently-used) or quota-based eviction:

```javascript
import { nlpwa } from 'nlpwa/client';

// Simple cleanup enforcing maxEntries
const result = await nlpwa.cleanupRuntimeCache({
  maxEntries: 50,
});
console.log(`Evicted ${result.evictedCount} items, freed ${(result.freedBytes / 1e3).toFixed(1)} KB`);

// Scoped cleanup matching specific URL patterns
await nlpwa.cleanupRuntimeCache({
  strategy: 'pattern',
  match: '/api/feed/*',
  maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  maxEntries: 20,
});
```
