# Client SDK — Multi-Tab Coherence & Version Pinning

NLPWA guarantees zero version drift across open tabs and protects active user sessions with multi-tab consensus and dirty form protection.

---

## 1. Client Version Pinning (Zero Version Drift)

In traditional PWAs, when a Service Worker updates in the background, subsequent `fetch` calls for lazy-loaded chunks (`/chunk-xyz.js`) hit the new version, while the page runs old code—often causing fatal chunk-load errors.

NLPWA solves this via **Version Pinning**:
- When a tab opens, it is pinned to the active cache version it booted with.
- All subsequent asset requests from that tab are served exclusively from that pinned version cache.
- The tab only upgrades when it navigates to a new document or when the user accepts an update banner.

---

## 2. Multi-Tab Consensus (`nlpwa-tab-bus`)

All open tabs communicate through an internal BroadcastChannel (`nlpwa-tab-bus`).

### Tab Leader Election
- Exactly one tab is elected **Tab Leader** via heartbeat consensus.
- The leader coordinates background update checks and staging, preventing multiple open tabs from hammering the server with redundant network requests.
- If the leader tab closes, a new leader is seamlessly elected in `<100ms`.

```javascript
import { nlpwa } from 'nlpwa/client';

if (nlpwa.isLeader()) {
  console.log('This tab is managing background coordination.');
}

window.addEventListener('nlpwa:tab-leader-changed', (e) => {
  console.log('Leader status changed:', e.detail.isLeader);
});
```

---

## 3. Dirty Form Protection: `registerDirtyGuard(fn)`

Prevents accidental data loss. If an update becomes ready and `autoReload: true` or `applyUpdate()` is invoked, NLPWA checks all registered dirty guards. If any form has unsaved edits, the reload is safely deferred.

```javascript
import { nlpwa } from 'nlpwa/client';

// Register a dirty guard in your form component
const unregister = nlpwa.registerDirtyGuard(() => {
  return form.isDirty && form.hasUnsavedChanges();
});

// Clean up when the component unmounts
onDestroy(() => unregister());
```

### Checking Across All Open Tabs: `checkDirtyTabs()`

Queries all open browser tabs via `nlpwa-tab-bus` to check if any tab is currently dirty:

```javascript
const { canReload, dirtyTabs } = await nlpwa.checkDirtyTabs();
if (!canReload) {
  console.log(`Update delayed: ${dirtyTabs.length} open tabs have unsaved edits.`);
}
```
