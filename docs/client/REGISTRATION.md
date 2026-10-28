# Client SDK — Registration & Updates

Initializes the Service Worker, configures update polling, monitors delta staging progress, and applies updates atomically.

---

## `register(swUrl, options)`

Initializes the Service Worker and registers automatic update pollers (on registration, window focus, interval, and periodic sync).

```javascript
import { register } from 'nlpwa/client';

register('/sw.js', {
  // Update Lifecycle Callbacks
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

  // Development & UI Design Mode
  dev: false,
});
```

### Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `dev` | `boolean` | `false` | When `true`, unregisters the Service Worker, flushes CacheStorage, and bypasses registration to allow live reloading and styling without cached assets. |
| `onUpdateReady` | `Function` | — | Called with `{ version }` when a new update has been fully staged in an isolated delta cache and verified against hashes. |
| `onNoUpdate` | `Function` | — | Called with `{ version }` when a version check confirms the app is already up to date. |
| `onUpdateFailed` | `Function` | — | Called with `{ version, failed, failedDetails, error, errorCode, quotaExceeded, retryCount, nextRetryAt, persistent, hasHashMismatch }` when update staging fails. |
| `onUpdateApplied` | `Function` | — | Called with `{ version }` after the Service Worker atomically switches active caches. |
| `onUpdatePrompt` | `Function` | — | Called with `{ version, reason }` when `applyUpdate()` is invoked with `prompt: true`. |
| `autoReload` | `boolean` | `false` | When `true`, automatically reloads the page when an update becomes ready. |
| `reloadOnUpdateApplied` | `boolean` | `false` | When `true`, automatically reloads after the update is committed into the active cache. |
| `shouldDeferReload` | `Function` | — | Predicate `({ version, reason }) => boolean` allowing custom deferrals (e.g. while video is playing). |
| `checkOnRegister` | `boolean` | `true` | Immediately checks for updates upon registration. |
| `checkOnFocus` | `boolean` | `true` | Checks for updates when the window regains focus (throttled). |
| `focusThrottleMs` | `number` | `3600000` | Minimum milliseconds between focus-triggered checks (default 1 hr). |
| `pollIntervalMs` | `number` | `3600000` | Background polling interval while app remains open (default 1 hr). |
| `periodicSync` | `boolean` | `true` | Registers Periodic Background Sync with the browser for installed PWAs. |

---

## Standalone Auto-Registration (`/client.js`)

When using the pre-bundled `/client.js` in a browser `<script src="/client.js"></script>` tag, the SDK automatically registers the Service Worker on load with zero setup.

### Placement & Custom Paths (`data-sw`, `data-scope`)

By default, auto-registration defaults explicitly to `/sw.js` at the origin root. Rather than fragile directory guessing that can silently register the Service Worker under the wrong scope, custom worker paths or scopes should be specified explicitly via script attributes or globals.

To explicitly configure the Service Worker path, custom scope, or disable auto-registration:

```html
<!-- Explicit custom Service Worker path -->
<script src="/static/js/client.js" data-sw="/custom/sw.js"></script>

<!-- Custom scope -->
<script src="/client.js" data-scope="/my-app/"></script>

<!-- Disable auto-registration (e.g. for purely manual register() calls) -->
<script src="/client.js" data-auto-register="false"></script>

<!-- Enable Development / UI Design Mode -->
<script src="/client.js" data-dev="true"></script>
```

Alternatively, set runtime globals prior to script load:
```javascript
window.NLPWA_SW_URL = '/custom/sw.js';
window.NLPWA_SW_SCOPE = '/my-app/';
window.NLPWA_DEV = true; // Enables Development Mode
```

---

## Development & UI Design Mode

When developing or iterating on UI designs, styling, or CSS animations, active Service Workers and cached assets can prevent immediate visibility of changes. NLPWA provides first-class Dev Mode support to completely bypass caching without requiring manual DevTools manipulation.

### Enabling Dev Mode

Dev Mode can be enabled locally in two ways (evaluated in order):
1. **Global runtime flag**:
   ```javascript
   window.NLPWA_DEV = true;
   ```
2. **Script tag attribute**:
   ```html
   <!-- Valueless attribute or data-dev="true" -->
   <script src="/client.js" data-dev></script>
   <!-- or -->
   <script src="/client.js" data-dev="true"></script>
   ```
   > **Note:** Only `""` (valueless attribute) and `"true"` turn Dev Mode on. Values such as `data-dev="false"` keep Dev Mode off.
   > Dev detection operates 100% locally with **zero network overhead**, ensuring production page loads and Service Worker registrations never wait on network requests.

### Dev Mode Behavior
When Dev Mode is detected:
- Existing Service Worker registrations for the current scope are immediately unregistered via `registration.unregister()`.
- Active CacheStorage stores (`offline`, `runtime`, `meta`) are completely flushed via `caches.delete()`.
- Service Worker registration is skipped, allowing all HTTP requests and asset updates to hit the network or local dev server directly.
- Full support for Vite, Webpack, and bundler Hot Module Replacement (HMR).

### Dev Mode Helpers
The Client SDK exports helper functions for checking and enforcing Dev Mode:

```javascript
import { isDevMode, enforceDevMode, isDevFlag } from 'nlpwa/client';

// Check if dev mode is currently active (checks window.NLPWA_DEV and script data-dev attribute):
const devActive = await isDevMode();

// Programmatically enforce dev mode (unregisters SW and wipes caches):
if (devActive) {
  await enforceDevMode();
}
```

### Automatic Recovery
When Dev Mode is deactivated (e.g. removing `data-dev` / `data-dev="true"` or deleting `window.NLPWA_DEV`), the SDK automatically restores normal Service Worker registration on the next page visit with no stale residue.

---

## Applying Updates: `applyUpdate(options)`

Instructs the Service Worker to commit a fully staged update into the active offline cache.

```javascript
import { applyUpdate } from 'nlpwa/client';

// Simple activation
await applyUpdate();

// Prompted activation with tab reload
await applyUpdate({
  prompt: true,
  reload: true,
  force: false, // Set to true to override dirty tab reload guards
});
```

---

## Observing Staging Progress: `onStagingProgress(callback)`

Subscribes to live progress updates during delta file staging:

```javascript
import { onStagingProgress } from 'nlpwa/client';

const unsubscribe = onStagingProgress(({ version, fetched, total, file, progressPercent }) => {
  console.log(`Staging v${version}: ${progressPercent}% (${fetched}/${total})`);
  progressBar.style.width = `${progressPercent}%`;
});

// To disconnect:
unsubscribe();
```

---

## Manual Update Triggers: `requestUpdateCheck(options)`

Triggers an immediate update check:

```javascript
import { requestUpdateCheck } from 'nlpwa/client';

// Regular check (respects throttle)
const hasUpdate = await requestUpdateCheck();

// Forced check (bypasses throttle and retry backoff)
const forcedUpdate = await requestUpdateCheck({ force: true });
```

---

## Querying Status & Version

```javascript
import { getVersion, getStatus } from 'nlpwa/client';

// Get current active version string
const version = await getVersion(); // e.g. "1.2.0-a1b2c3d4"

// Get detailed status snapshot
const status = await getStatus();
// {
//   activeVersion: '1.2.0',
//   stagedVersion: null,
//   updateAvailable: false,
//   swState: 'activated'
// }
```

---

## DOM Events Reference

NLPWA dispatches standard CustomEvents on the `window` object:

| Event Name | `event.detail` | Description |
|---|---|---|
| `nlpwa:update-ready` | `{ version }` | Fired when an update finishes staging and is ready to activate. |
| `nlpwa:no-update` | `{ version }` | Fired when check confirms app is up to date. |
| `nlpwa:update-applied` | `{ version }` | Fired when the active version switches. |
| `nlpwa:update-failed` | `{ version, error, failedDetails }` | Fired when staging fails. |
| `nlpwa:update-prompt` | `{ version, reason }` | Fired when update prompts for confirmation. |
| `nlpwa:staging-progress` | `{ version, fetched, total, file, progressPercent }` | Fired on each staged file. |
| `nlpwa:tab-leader-changed` | `{ isLeader }` | Fired when the current tab becomes or resigns as the leader. |
