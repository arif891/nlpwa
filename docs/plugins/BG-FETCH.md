# Background Fetch Plugin (`nlpwa/bg-fetch`)

Manages large file downloads (podcasts, videos, ML weights, 3D assets, games) and background uploads with native OS progress indicators, automatic totals discovery, and resilient offline cache routing.

---

## Architecture Overview

```
[ Web Client ]                              [ Service Worker ]                             [ Cache Storage ]
      │                                             │                                              │
      │── backgroundFetchClient.fetch(urls) ───────>│                                              │
      │   (Parallel HEAD discovers totals)          │── self.registration.backgroundFetch.fetch ──>│
      │                                             │   (Native OS Download Bar)                   │
      │                                             │                                              │
      │<─ onProgress({ percent, downloaded }) ──────│ (Live updates)                               │
      │                                             │                                              │
      │                                             │── backgroundfetchsuccess ───────────────────>│
      │                                             │   ├── Resolve Target Cache                   │
      │                                             │   │   (offline@ver, route cache, runtime)    │
      │                                             │   ├── Stream to native CacheStorage          │
      │                                             │   ├── If POST: Parse upload response         │
      │                                             │   └── event.updateUI({ title, icons })       │
      │<─ onSuccess({ count, cacheName }) ──────────│                                              │
```

---

## Service Worker Configuration

Import and register `BackgroundFetchPlugin` in `sw.js`:

```javascript
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
      title: 'Download complete',
      failTitle: 'Transfer failed',
    }),
  ],
});
```

### Event Handling & Caching Lifecycle

1. **Intelligent Cache Target Resolution**:
   - Manifest & precache assets automatically resolve to the active offline version cache (`offline@<version>`).
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

---

## Client SDK Reference (`backgroundFetchClient`)

```javascript
import {
  backgroundFetchClient,
  getBgFetchIdForUrl,
  getUrlFromBgFetchId,
} from 'nlpwa/bg-fetch/client';
```

### `fetch(id, requests, options)` / `fetch(requests, options)`

Starts a background fetch download or upload task.

#### Overloaded Signatures
- `fetch(id, requests, options)` — Custom task ID with single or multiple URLs.
- `fetch(requests, options)` — Auto-generates an ID (`nlpwa-bg:${encodeURIComponent(url)}` for single URLs, or a unique timestamped ID for arrays).

#### Options
| Option | Type | Description |
|---|---|---|
| `title` | `string` | Notification title shown by the native OS |
| `icons` | `Array<{ src, sizes, type }>` | Icon list for the OS tray notification |
| `downloadTotal` | `number` | Expected download size in bytes. Automatically detected via `HEAD` if omitted |
| `uploadTotal` | `number` | Expected upload size in bytes. Automatically detected from `Blob`/`File` request bodies |
| `autoDetermineTotals` | `boolean` | Whether to auto-detect totals (default: `true`) |
| `onProgress` | `Function` | Callback receiving `{ id, downloaded, downloadTotal, uploaded, uploadTotal, percent }` |

#### Examples

```javascript
// 1. Single-file download with auto-generated deterministic ID:
const download = await backgroundFetchClient.fetch('/models/llama-3.bin', {
  title: 'Downloading LLM Weights (4.2 GB)',
  onProgress: ({ percent, downloaded, downloadTotal }) => {
    console.log(`${percent}% (${(downloaded / 1e6).toFixed(1)} / ${(downloadTotal / 1e6).toFixed(1)} MB)`);
  },
});

// 2. Multi-file batch download with custom ID:
const album = await backgroundFetchClient.fetch('album-stellar-voyage', [
  '/audio/track1.mp3',
  '/audio/track2.mp3',
  '/audio/cover.jpg',
], {
  title: 'Downloading Album',
  onProgress: ({ percent }) => updateUI(percent),
});
```

### `getForUrl(url)`
Finds an active background fetch task for a URL using its deterministic escaped URL ID. Returns the `BackgroundFetchRegistration` or `null`.

```javascript
const active = await backgroundFetchClient.getForUrl('/models/llama-3.bin');
if (active) {
  // Re-attach progress tracking from any other tab or page view
  backgroundFetchClient.onProgress(active, ({ percent }) => {
    progressBar.style.width = `${percent}%`;
  });
}
```

### `onProgress(target, callback)`
Subscribes to live progress updates on a `BackgroundFetchRegistration` object or task ID string. Returns an `unsubscribe()` function.

```javascript
const unsub = backgroundFetchClient.onProgress('album-stellar-voyage', (p) => {
  progressBar.value = p.percent;
});

// To disconnect:
unsub();
```

### `onSuccess(callback)` / `onFail(callback)` / `onAbort(callback)`
Global lifecycle listeners for broadcasts from the Service Worker:

```javascript
backgroundFetchClient.onSuccess(({ id, count, cacheName, isUpload, uploadResults }) => {
  console.log(`Task ${id} completed. Stored ${count} assets in ${cacheName}.`);
  if (isUpload) {
    console.log('Upload server response:', uploadResults);
  }
});

backgroundFetchClient.onFail(({ id, failureReason }) => {
  console.error(`Task ${id} failed: ${failureReason}`);
});
```
