# Web Share Target Plugin (`nlpwa/share`)

Captures incoming shares from native apps and mobile share sheets into an offline FIFO queue with automatic file hydration.

---

## Service Worker Configuration

Import and register `ShareTargetPlugin` in `sw.js`:

```javascript
import { initSW } from 'nlpwa/sw';
import { ShareTargetPlugin } from 'nlpwa/share';

initSW({
  plugins: [
    new ShareTargetPlugin({
      // Form action URL defined in manifest.webmanifest share_target
      action: '/_share-target',
      // Destination URL to redirect the user after storing shared data
      redirectUrl: '/?shared=1',
      // Maximum combined payload size in bytes (default: 25 MB)
      maxPayloadBytes: 25 * 1024 * 1024,
      // Maximum number of pending shares to keep in offline queue (default: 50)
      maxQueueSize: 50,
    }),
  ],
});
```

### Web App Manifest Integration

In your `manifest.webmanifest`:

```json
{
  "name": "My Notes PWA",
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
          "name": "media",
          "accept": ["image/*", "application/pdf"]
        }
      ]
    }
  }
}
```

---

## Client SDK Usage

```javascript
import { onShareTarget, getSharedData } from 'nlpwa/share';

// 1. Subscribe to shared items on page boot
onShareTarget((shared) => {
  console.log('Received share:', shared.title, shared.text, shared.url);
  for (const file of shared.files) {
    console.log(`Attached file: ${file.name} (${file.type}, ${file.blob.size} bytes)`);
  }
});

// 2. Or query shared data on demand (e.g. if arriving via redirectUrl)
const pending = await getSharedData();
if (pending) {
  displayImportModal(pending);
}
```
