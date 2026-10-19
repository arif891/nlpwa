# NLPWA — Client SDK & Runtime API

The NLPWA Client SDK (`client.js` or `nlpwa/client`) manages Service Worker registration, over-the-air update events, multi-tab version synchronization, and browser cache storage quotas.

It is available as both an ES module (`import { register } from 'nlpwa/client'`) and a pre-bundled standalone IIFE script (`/client.js`) defining `window.NLPWAClient`.

---

## Table of Contents

- [Quick Integration](#quick-integration)
- [Registration & Options: `register(swUrl, options)`](#registration--options-registerswurl-options)
- [Applying Updates: `applyUpdate(options)`](#applying-updates-applyupdateoptions)
- [Querying Status & Version: `getVersion()` and `getStatus()`](#querying-status--version-getversion-and-getstatus)
- [Observing Staging Progress: `onStagingProgress(callback)`](#observing-staging-progress-onstagingprogresscallback)
- [Manual Update Triggers: `requestUpdateCheck()`](#manual-update-triggers-requestupdatecheck)
- [Unregistering: `unregister(scope)`](#unregistering-unregisterscope)
- [DOM Events Reference](#dom-events-reference)
- [Multi-Tab Coherence & SPA Integration](#multi-tab-coherence--spa-integration)
- [Storage Quota & Runtime Cache Cleanup](#storage-quota--runtime-cache-cleanup)

---

## Quick Integration

### Drop-in Script (No Bundler)

```html
<!-- In index.html before closing </body> -->
<script src="/client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version }) => {
      document.getElementById('update-banner').hidden = false;
    },
  });
</script>

<div id="update-banner" hidden>
  <span>A new version is ready!</span>
  <button onclick="NLPWAClient.applyUpdate()">Update Now</button>
</div>
```

### ES Module / Bundler (Vite, Rollup, Webpack)

```javascript
import { register, applyUpdate, onStagingProgress } from 'nlpwa/client';

register('/sw.js', {
  autoReload: false,
  reloadOnUpdateApplied: true,
  onUpdateReady: ({ version }) => {
    console.log(`Update ${version} staged and ready!`);
  },
});
```

---

## Registration & Options: `register(swUrl, options)`

Initializes the Service Worker, sets up postMessage channels, and registers automatic update pollers (on registration, window focus, interval, and periodic sync).

```javascript
NLPWAClient.register('/sw.js', {
  // Callbacks
  onUpdateReady: ({ version }) => {},
  onNoUpdate: ({ version }) => {},
  onUpdateFailed: (details) => {},
  onUpdateApplied: ({ version }) => {},
  onUpdatePrompt: ({ version, reason }) => {},

  // Reload & Coherence
  autoReload: false,
  reloadOnUpdateApplied: false,
  shouldDeferReload: ({ version, reason }) => false,

  // Polling & Lifecycles
  checkOnRegister: true,
  checkOnFocus: true,
  periodicSync: true,
  focusThrottleMs: 60 * 60 * 1000,
  pollIntervalMs: 60 * 60 * 1000,
});
```

### Complete Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `onUpdateReady` | `Function` | — | Called with `{ version }` when a new update has been fully staged in an isolated cache and verified against manifest hashes. |
| `onNoUpdate` | `Function` | — | Called with `{ version }` when a Tier 1 or Tier 2 check confirms the running app is already up to date. |
| `onUpdateFailed` | `Function` | — | Called with `{ version, failed, failedDetails, error, errorCode, quotaExceeded, retryCount, nextRetryAt, persistent, hasHashMismatch }` when update staging fails (e.g. network dropout or SHA-256 hash mismatch). |
| `onUpdateApplied` | `Function` | — | Called with `{ version }` when an update is committed across any browser tab or window. |
| `onUpdatePrompt` | `Function` | — | Called when an automatic reload is suppressed because the user is actively typing in a form input, textarea, or `shouldDeferReload()` returned `true`. |
| `shouldDeferReload` | `Function` | — | Predicate function `({ version, reason }) => boolean`. Return `true` to cancel an automatic reload (e.g., if there are unsaved document edits or background uploads in progress). |
| `autoReload` | `boolean` | `false` | When `true`, automatically commits the staged update and reloads the active tab immediately when staging finishes (deferred if form editing or `shouldDeferReload` is active). |
| `reloadOnUpdateApplied` | `boolean` | `false` | When `true`, automatically reloads this tab if *another* open tab applies an update, keeping all open tabs coherent. |
| `checkOnRegister` | `boolean` | `true` | Triggers a non-blocking background update check immediately after registering the Service Worker. |
| `checkOnFocus` | `boolean` | `true` | Checks for updates when the browser window or tab regains focus. |
| `focusThrottleMs` | `number` | `3600000` (1h) | Minimum milliseconds between focus-triggered update checks to prevent rapid network spam. |
| `pollIntervalMs` | `number` | `3600000` (1h) | Recurring interval in milliseconds to check for updates while the tab remains open and active. |
| `periodicSync` | `boolean` | `true` | Requests Chromium Periodic Background Sync (`nlpwa-update-sync`, min 24h interval) for installed PWAs. |

---

## Applying Updates: `applyUpdate(options)`

Requests the Service Worker to switch the active cache pointer from the old version to the staged version via a dedicated two-way `MessageChannel`.

```javascript
await NLPWAClient.applyUpdate({
  timeoutMs: 3000,
  reload: true,
});
```

### Options

| Parameter | Type | Default | Description |
|---|---|---|---|
| `timeoutMs` | `number` | `3000` | Maximum milliseconds to wait for the Service Worker's `APPLY_UPDATE_RESULT` confirmation before forcing page reload. |
| `reload` | `boolean` | `true` | Whether to automatically call `window.location.reload()`. Set to `false` in single-page apps (SPAs) if you want to switch caches behind the scenes without reloading the page. |

If the Service Worker returns `applied: false` (e.g., if no staged update is actually complete), `applyUpdate` aborts without reloading.

---

## Querying Status & Version: `getVersion()` and `getStatus()`

Inspect the Service Worker engine version, active app version, and staging status on demand.

```javascript
import { getVersion, getStatus } from 'nlpwa/client';

// Query versions
const versionInfo = await getVersion();
console.log(versionInfo);
// Output:
// {
//   version: '1',                               // SW engine version
//   activeVersion: '1.0.0-a1b2c3d4e5f6',        // Active app version
//   stagedVersion: '1.0.1-f7e8d9c0b1a2'         // Staged version waiting for commit (or null)
// }

// Query full engine status
const statusInfo = await getStatus();
console.log(statusInfo);
// Output:
// {
//   status: 'staging',                          // 'idle' | 'staging' | 'ready'
//   activeVersion: '1.0.0-a1b2c3d4e5f6',
//   stagedVersion: '1.0.1-f7e8d9c0b1a2',
//   percent: 64                                 // Staging download percentage (or null)
// }
```

---

## Observing Staging Progress: `onStagingProgress(callback)`

Subscribe to live file-by-file staging and hash-verification events. Ideal for custom download progress bars or offline readiness indicators.

```javascript
import { onStagingProgress } from 'nlpwa/client';

const unsubscribe = onStagingProgress(({ loaded, total, percent, file }) => {
  console.log(`Downloading update: ${percent}% (${loaded}/${total}) — ${file}`);
  progressBar.style.width = `${percent}%`;
});

// To stop listening:
unsubscribe();
```

---

## Manual Update Triggers: `requestUpdateCheck()`

Trigger an on-demand update check at any time (e.g., when a user clicks "Check for updates" in app settings):

```javascript
import { requestUpdateCheck } from 'nlpwa/client';

// Clean helper:
requestUpdateCheck();

// Or raw Service Worker postMessage:
const reg = await navigator.serviceWorker.ready;
(navigator.serviceWorker.controller || reg.active)?.postMessage({ type: 'CHECK_UPDATE' });
```

---

## Unregistering: `unregister(scope)`

Completely unregisters all active Service Worker registrations (matching optional scope) and removes all client-side event listeners and poll timers:

```javascript
import { unregister } from 'nlpwa/client';

// Unregister SW for current scope
await unregister();

// Or target specific scope
await unregister('/app/');
```

---

## DOM Events Reference

Whenever NLPWA receives update signals from the Service Worker, it dispatches standard CustomEvents on the `document` object. You can listen with standard `document.addEventListener()`:

```javascript
// 1. Update staged and ready to apply
document.addEventListener('nlpwa:update-ready', (e) => {
  const { version } = e.detail;
  console.log('Update ready:', version);
});

// 2. Confirmed up to date (Tier 1 check matched)
document.addEventListener('nlpwa:no-update', (e) => {
  const { version } = e.detail;
  console.log('Already on latest:', version);
});

// 3. Staging failed (network dropout or corrupted hash)
document.addEventListener('nlpwa:update-failed', (e) => {
  const { error, failed, hasHashMismatch } = e.detail;
  console.warn('Update failed:', error, failed);
});

// 4. Update committed (in this tab or another tab)
document.addEventListener('nlpwa:update-applied', (e) => {
  const { version } = e.detail;
  console.log('Active version changed to:', version);
});

// 5. Automatic reload was deferred because the user is editing a form
document.addEventListener('nlpwa:update-prompt', (e) => {
  const { version, reason } = e.detail;
  console.log(`Update ${version} ready, reload deferred because: ${reason}`);
  showNonIntrusiveBanner();
});
```

---

## Multi-Tab Coherence & SPA Integration

In modern web applications with multiple open tabs and client-side routing, Service Worker updates can cause race conditions if unmanaged.

### 1. Form-Edit Protection & Dirty Fields

If `autoReload: true` or `reloadOnUpdateApplied: true` is configured, NLPWA guards against discarding unsaved user data:

1. **Active Focus Check**: If the user is currently focused on an `<input>`, `<textarea>`, `<select>`, or `contenteditable` element, the reload is immediately deferred.
2. **Blurred Dirty Input Check**: Even if the user clicked away or blurred focus, NLPWA scans the DOM for any `<input>` or `<textarea>` where `value !== defaultValue`, or any container marked with `[data-dirty="true"]` or `[data-unsaved="true"]`.
3. **Application State Integration (`shouldDeferReload`)**: For SPAs using React Hook Form, Formik, TanStack Form, or Vue/Pinia stores, pass a custom `shouldDeferReload` predicate:

```javascript
NLPWAClient.register('/sw.js', {
  autoReload: true,
  reloadOnUpdateApplied: true,

  // Defer auto-reload if an in-memory form is dirty or a background job is running
  shouldDeferReload: ({ version, reason }) => {
    return formStore.isDirty || uploadQueue.hasPendingUploads();
  },

  // Called whenever an auto-reload is deferred to show a non-intrusive prompt
  onUpdatePrompt: ({ version, reason }) => {
    document.getElementById('update-notification').hidden = false;
  },
});
```

Unsaved user entries and form states are never wiped without permission.

### 2. Multi-Tab Coherence

When Tab A commits an update via `applyUpdate()`, the Service Worker broadcasts `UPDATE_APPLIED` to all other open tabs. Setting:

```javascript
NLPWAClient.register('/sw.js', {
  reloadOnUpdateApplied: true,
});
```

Ensures that background tabs quietly synchronize with the newly committed version when safe.

### 3. SPA Route Navigation Transition

In client-side SPAs (Vue Router, React Router, SvelteKit), HTML navigations are intercepted by `pushState`. Staged updates will not apply on route change unless prompted. You can apply staged updates seamlessly during router transitions:

```javascript
// Example: Vue Router / React Router navigation hook
let updateStaged = false;

document.addEventListener('nlpwa:update-ready', () => {
  updateStaged = true;
});

router.beforeEach(async (to, from) => {
  if (updateStaged) {
    // Option A: Full reload to boot new bundle on route change
    NLPWAClient.applyUpdate();
    return false;

    // Option B: Atomically swap cache without full reload
    // await NLPWAClient.applyUpdate({ reload: false });
    // updateStaged = false;
  }
});
```

---

## Storage Quota & Runtime Cache Cleanup

NLPWA provides native cache quota inspection and intelligent pruning for runtime cached assets.

```javascript
import { getCacheInfo, cleanupRuntimeCache } from 'nlpwa/client';
```

### Inspecting Storage: `getCacheInfo()`

```javascript
const info = await getCacheInfo();
console.log(info);
// {
//   usage: 15482910,            // Total browser origin storage usage in bytes
//   quota: 2147483648,          // Total origin quota limit in bytes
//   percentUsed: 0.72,          // Percentage of quota consumed
//   runtimeEntries: 42,         // Total entries stored in runtime cache
//   runtimeBytes: 8392100,      // Size of runtime cache in bytes
//   largestEntries: [           // Top 10 largest entries in runtime cache
//     { url: '/assets/video.mp4', size: 5242880 },
//     { url: '/assets/model.onnx', size: 2097152 },
//   ]
// }
```

### Pruning Runtime Cache: `cleanupRuntimeCache(options)`

Clean runtime assets on demand or proactively to keep user storage lean.

```javascript
// Free space by removing the largest files until runtime cache is under 50 MB
await cleanupRuntimeCache({
  strategy: 'largest',
  maxTotalMB: 50,
});

// Evict any single file larger than 5 MB
await cleanupRuntimeCache({
  maxItemMB: 5,
});

// Keep origin storage under 75% of browser quota
await cleanupRuntimeCache({
  strategy: 'quota',
  maxQuotaPercent: 75,
});

// Keep last 100 most recently used entries (LRU)
await cleanupRuntimeCache({
  strategy: 'lru',
  maxEntries: 100,
});

// Evict files older than 7 days
await cleanupRuntimeCache({
  strategy: 'max-age',
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});

// Evict specific glob URL pattern
await cleanupRuntimeCache({
  strategy: 'pattern',
  match: '/assets/temp/**',
});

// Wipe entire runtime cache
await cleanupRuntimeCache({
  strategy: 'all',
});
```

### Size Specifier Flexibility

All size options accept any of the following formats:
- Megabytes: `maxTotalMB: 50`
- Kilobytes: `maxTotalKB: 500`
- Bytes: `maxTotalBytes: 52428800`
- String with units: `maxTotal: '50MB'`, `maxItem: '500KB'`

### Cleanup Strategies Summary

| Strategy | Key Options | Behavior |
|---|---|---|
| `'largest'` | `maxTotalMB` / `maxTotalKB` / `maxTotalBytes`, `maxEntries`, `minItemMB` | Sorts runtime files by byte size descending and evicts largest files first. |
| `'lru'` | `maxEntries`, `maxTotalMB` / `maxTotalBytes` | Sorts runtime files by timestamp ascending and evicts oldest accessed files first. |
| `'max-age'` | `maxAgeMs` | Evicts any runtime entry cached longer ago than `maxAgeMs`. |
| `'quota'` | `maxQuotaPercent`, `maxQuotaMB`, `preferLargest` | Checks origin quota via `navigator.storage.estimate()` and evicts until within threshold. |
| `'pattern'` | `match` (glob pattern) | Evicts entries whose URLs match the specified glob. |
| `'all'` | — | Evicts all entries in the `runtime` cache. |
