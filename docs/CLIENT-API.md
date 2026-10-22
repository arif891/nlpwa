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
- [Unified Singleton: `nlpwa` / `client`](#unified-singleton-nlpwa--client)
- [Unified Reactive State Store: `getState()` & `subscribe()`](#unified-reactive-state-store-getstate--subscribe)
- [PWA Installation Manager](#pwa-installation-manager)
- [Persistent Storage: `isStoragePersistent()` & `requestPersistentStorage()`](#persistent-storage-isstoragepersistent--requestpersistentstorage)
- [OS Badging API](#os-badging-api)
- [Web Share Target API](#web-share-target-api)
- [Background Fetch API: `backgroundFetchClient`](#background-fetch-api-backgroundfetchclient)

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

---

## Unified Singleton: `nlpwa` / `client`

The SDK provides a consolidated `nlpwa` (aliased as `client`) singleton that exposes all client capabilities in a single ergonomic object.

```javascript
import { nlpwa } from 'nlpwa/client';
// or in browser without bundler:
// const { nlpwa } = window.NLPWAClient;

// Reactive state
const state = nlpwa.getState();
const unsubscribe = nlpwa.subscribe((state) => {
  console.log('App state changed:', state);
});

// PWA Installation
if (nlpwa.isInstallable()) {
  await nlpwa.install();
}

// Storage Persistence
await nlpwa.requestPersistentStorage();

// Badging
await nlpwa.setBadge(5);
await nlpwa.clearBadge();

// Web Share Target
const sharedData = await nlpwa.getSharedData();
nlpwa.onShareTarget((data) => {
  console.log('Received shared content:', data);
});

// Updates
await nlpwa.checkUpdate();
await nlpwa.applyUpdate();
```

---

## Unified Reactive State Store: `getState()` & `subscribe()`

NLPWA maintains a centralized, reactive status store synchronizing network connectivity, update lifecycles, installation readiness, and OS badges into a single object.

### Reading State Synchronously

```javascript
import { getState } from 'nlpwa/client';

const state = getState();
console.log(state);
```

### Subscribing to State Changes

The listener receives the latest state immediately upon subscription, followed by any updates:

```javascript
import { subscribe } from 'nlpwa/client';

const unsubscribe = subscribe((state) => {
  // Sync your UI components or framework stores (React, Vue, Svelte)
  updateStatusBanner(state.updateStatus);
  installButton.hidden = !state.isInstallable;
  offlineIndicator.hidden = state.online;
});

// Stop listening
unsubscribe();
```

### `NLPWAState` Shape

| Field | Type | Description |
|---|---|---|
| `online` | `boolean` | `true` if browser has active network connection; `false` if offline. |
| `updateStatus` | `string` | Current lifecycle: `'idle'`, `'checking'`, `'staging'`, `'ready'`, `'applying'`, `'commit-deferred'`, or `'failed'`. |
| `version` | `string \| null` | Running application version string. |
| `activeVersion` | `string \| null` | Version currently serving cached requests. |
| `stagedVersion` | `string \| null` | Newer version staged in the background (ready to apply). |
| `minVersion` | `string \| null` | Minimum server-required version (if broadcast via Tier 1). |
| `updateRequired` | `boolean` | `true` if current version is deprecated and an update must be applied. |
| `isInstallable` | `boolean` | `true` if browser captured `beforeinstallprompt` and app is ready to install. |
| `isInstalled` | `boolean` | `true` if app is launched in standalone mode or was already installed. |
| `isStoragePersistent` | `boolean \| null` | `true` if browser granted persistent storage exemption from eviction. |
| `badgeCount` | `number \| null` | Current numerical badge count or `null` if cleared/unset. |
| `stagingProgress` | `object \| null` | Progress object `{ loaded, total, percent, file }` during staging. |

---

## PWA Installation Manager

NLPWA automatically intercepts the browser's native `beforeinstallprompt` event, retains the deferred prompt across navigation, and exposes a clean promise-based trigger.

```javascript
import { isInstallable, isInstalled, onInstallable, promptInstall } from 'nlpwa/client';

// Listen for install availability
onInstallable(({ isInstallable }) => {
  installButton.hidden = !isInstallable;
});

// Trigger prompt from a button click
installButton.addEventListener('click', async () => {
  const result = await promptInstall();
  if (result.outcome === 'accepted') {
    console.log('User installed the PWA!');
  }
});

// Check standalone display mode
if (isInstalled()) {
  console.log('Running as an installed standalone app');
}
```

---

## Persistent Storage: `isStoragePersistent()` & `requestPersistentStorage()`

Browsers may evict cached data under device storage pressure unless persistent storage is granted. NLPWA provides lightweight wrappers over the Storage API with silent degradation.

```javascript
import { isStoragePersistent, requestPersistentStorage } from 'nlpwa/client';

// Check if persistent storage is already granted
const isPersistent = await isStoragePersistent();

// Request persistent storage (typically invoked after install or user login)
const granted = await requestPersistentStorage();
if (granted) {
  console.log('Storage is protected from automatic browser eviction');
}
```

---

## OS Badging API

Sets or clears app icon badges on supported desktop and mobile operating systems (Windows Taskbar, macOS Dock, Android, and iOS 16.4+). Degrades silently on unsupported browsers.

```javascript
import { isBadgingSupported, setAppBadge, clearAppBadge } from 'nlpwa/client';

if (isBadgingSupported()) {
  // Set numeric badge
  await setAppBadge(3);

  // Set uncounted dot badge
  await setAppBadge();

  // Clear badge
  await clearAppBadge();
}
```

> **Push Badging:** Badges can also be set directly by your push backend:
> ```json
> {
>   "title": "New Message",
>   "body": "You have a new message",
>   "badge": 5
> }
> ```
> When the user clicks the notification, the Service Worker automatically clears the badge.

---

## Web Share Target API

Allows your PWA to receive shared links, text, and files directly from other native apps via the system Share sheet.

### Manifest Configuration

Generated automatically by `nlpwa init` or configured in `manifest.webmanifest`:

```json
{
  "share_target": {
    "action": "/_share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [
        {
          "name": "files",
          "accept": ["*/*"]
        }
      ]
    }
  }
}
```

### Receiving Shared Data in the Client

When the OS launches your app from a Share action, the Service Worker intercepts the payload, issues a 303 redirect to your app, and makes the data accessible:

```javascript
import { getSharedData, onShareTarget } from 'nlpwa/client';

// Option 1: Listen for incoming shares reactively
onShareTarget((shared) => {
  console.log('Title:', shared.title);
  console.log('Text:', shared.text);
  console.log('URL:', shared.url);
  console.log('Files:', shared.files); // Array of { name, type, size, data }
});

// Option 2: Check for pending shared data on page load
const pending = await getSharedData();
if (pending) {
  handleSharedContent(pending);
}
```

---

## Multi-Boot Probation & Boot Watchdog

When a new version commits, it enters a multi-boot probation state. The Service Worker retains the previous known-good version in `nlpwa-fallback` and monitors the boot lifecycle across browser sessions.

- **First-Party Error Filtering:** The watchdog automatically filters out crashes from browser extensions (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) and third-party trackers (GTM, ads, Sentry), counting only first-party application crashes.
- **2-Strike Rollback Threshold:** A single glitch will not roll back a release. 2 consecutive first-party boot failures are required before the Service Worker rolls back to `nlpwa-fallback`.
- **24-Hour Block Expiration:** Blocked releases on a client automatically expire after 24 hours (configurable via `probation.clientBlockTtlMs`).
- **Graduation to Stable:** Once the new release boots healthily twice (`nlpwa.markHealthy()`), it is promoted to stable and the fallback cache is swept cleanly.

### `nlpwa.markHealthy()`

Explicitly confirms that the application has initialized and rendered successfully. Increments healthy boot count and graduates from probation once `requiredHealthyBoots` (default: 2) is reached.

```javascript
import { nlpwa } from 'nlpwa/client';

// In your root mount / main component:
try {
  await renderRootApplication();
  nlpwa.markHealthy();
} catch (err) {
  nlpwa.reportBootFailure(err);
}
```

### `nlpwa.reportBootFailure(error)`

Manually reports a critical first-party initialization failure. Increments consecutive boot failure count; upon reaching the threshold (default: 2), instructs the Service Worker to roll back to `nlpwa-fallback`, block the offending release locally for 24 hours, and reload into the stable state.

```javascript
nlpwa.reportBootFailure(new Error('Critical chunk missing'));
```

---

## Multi-Tab Consensus & Dirty Form Protection

Coordinate updates across open tabs and prevent unwanted reloads while forms or documents have unsaved changes.

### `nlpwa.setDirty(isDirty)`

Manually sets the dirty status for the current tab.

```javascript
nlpwa.setDirty(true);  // Mark as having unsaved edits
nlpwa.setDirty(false); // Clean
```

### `nlpwa.registerDirtyGuard(guardFn)`

Registers a synchronous or asynchronous callback that returns `true` if the tab contains unsaved work.

```javascript
nlpwa.registerDirtyGuard(() => {
  return document.querySelector('#comment-textarea').value.length > 0;
});
```

### `nlpwa.checkDirtyTabs()`

Queries all open browser tabs via `nlpwa-tab-bus` to check if any tab is currently dirty.

```javascript
const { canReload, dirtyTabs } = await nlpwa.checkDirtyTabs();
if (!canReload) {
  console.log(`Update delayed: ${dirtyTabs.length} tabs have unsaved edits`);
}
```

---

## Runtime Observability & Diagnostics

### `nlpwa.diagnostics()`

Queries the Service Worker and returns a comprehensive snapshot of cache status, pins, fallbacks, storage quotas, and tab coordination.

```javascript
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

Inspects the version pinning state of the current tab.

```javascript
const { pinnedVersion, activeVersion, isPinned } = await nlpwa.getPinStatus();
```

---

## Background Fetch API: `backgroundFetchClient`

The Background Fetch Client (`nlpwa/bg-fetch/client` or `window.NLPWABgFetchClient.backgroundFetchClient`) manages background downloads and uploads that persist even after the browser tab is closed, accompanied by native OS progress indicators.

```javascript
import { backgroundFetchClient, getBgFetchIdForUrl, getUrlFromBgFetchId } from 'nlpwa/bg-fetch/client';
```

### Methods Reference

#### `backgroundFetchClient.isSupported()`
Returns `true` if `BackgroundFetchManager` is supported by the user's browser.

#### `backgroundFetchClient.fetch(id, requests, options)` / `backgroundFetchClient.fetch(requests, options)`
Starts a background fetch download or upload task.

- **Overloads**:
  1. `fetch(id, requests, options)` — Explicit custom ID with one or more URLs.
  2. `fetch(requests, options)` — Auto-generates an ID (`nlpwa-bg:${encodeURIComponent(url)}` for single URLs, or a timestamped ID for arrays).
- **Options**:
  - `title`: Notification title shown by the native OS.
  - `icons`: Icon list for OS notification.
  - `downloadTotal`: Expected download size in bytes. If omitted, automatically detects via parallel `HEAD` requests.
  - `uploadTotal`: Expected upload size in bytes. If omitted, automatically detects from `Blob` / `File` request bodies.
  - `onProgress`: Live progress callback `{ id, downloaded, downloadTotal, uploaded, uploadTotal, percent }`.

```javascript
// Single asset download with auto-generated deterministic ID:
await backgroundFetchClient.fetch('/models/large-model.onnx', {
  title: 'Downloading Neural Network Model',
  onProgress: ({ percent, downloaded, downloadTotal }) => {
    progressBar.value = percent;
  },
});

// Multi-file batch download with custom ID:
await backgroundFetchClient.fetch('album-release-01', [
  '/audio/track1.mp3',
  '/audio/track2.mp3',
  '/audio/cover.jpg',
], {
  title: 'Downloading Album',
  onProgress: ({ percent }) => updateUI(percent),
});
```

#### `backgroundFetchClient.getForUrl(url)`
Looks up an active background fetch task for a given URL using its deterministic escaped URL ID. Returns the `BackgroundFetchRegistration` or `null`.

```javascript
const activeTask = await backgroundFetchClient.getForUrl('/models/large-model.onnx');
if (activeTask) {
  // Resume observing progress from another tab or view
  backgroundFetchClient.onProgress(activeTask, ({ percent }) => {
    console.log(`Still downloading: ${percent}%`);
  });
}
```

#### `backgroundFetchClient.onProgress(target, callback)`
Attaches a live progress listener to a `BackgroundFetchRegistration` or task ID. Returns an `unsubscribe()` function.

```javascript
const unsubscribe = backgroundFetchClient.onProgress('album-release-01', (p) => {
  console.log(`${p.percent}% (${p.downloaded}/${p.downloadTotal} bytes)`);
});

// Stop listening
unsubscribe();
```

#### `backgroundFetchClient.get(id)`
Retrieves an active task by its string ID.

#### `backgroundFetchClient.getIds()`
Returns an array of all active background fetch task IDs.

#### `backgroundFetchClient.abort(id)`
Cancels an active background fetch task.

#### `backgroundFetchClient.onSuccess(callback)`
Registers a listener for `BG_FETCH_SUCCESS` broadcasts sent by the Service Worker when transfers finish:
```javascript
backgroundFetchClient.onSuccess(({ id, count, cacheName, storedRequests, uploadResults, isUpload }) => {
  console.log(`Task ${id} completed with ${count} files stored in ${cacheName}.`);
});
```

#### `backgroundFetchClient.onFail(callback)` / `backgroundFetchClient.onAbort(callback)`
Listeners for task failures and user-initiated aborts.



