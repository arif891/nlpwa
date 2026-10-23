# Web Push Plugin (`nlpwa/push`)

The `nlpwa/push` plugin is an official zero-runtime-dependency extension that manages Web Push notifications, user permissions, Base64/URL-safe VAPID key conversion, interactive notification action button routing, and click navigation with progressive enhancement.

---

## Key Capabilities

- **Zero Boilerplate:** Converts URL-safe base64 VAPID public keys to `Uint8Array` internally without manual bitwise parsing.
- **Progressive Enhancement:** Gracefully checks browser capabilities (`Notification`, `PushManager`, `ServiceWorker`) and permission status (`granted`, `denied`, `default`, `unsupported`) without throwing unhandled exceptions.
- **Interactive Action Routing:** Maps custom notification button actions (e.g. `'view-article'`, `'reply'`) directly to handler functions inside the Service Worker.
- **Window Focus & Navigation:** Focuses an existing open window client matching the notification URL or opens a new window seamlessly.
- **Badge Integration:** Automatically updates or clears OS app icon badges based on push payloads.

---

## Installation

### For Bundlers (Vite / Rollup / Webpack)

```bash
npm install nlpwa
```

Subpath exports:
- `nlpwa/push` (Combined exports)
- `nlpwa/push/client` (Client SDK)
- `nlpwa/push/sw` (Service Worker plugin)

### For No-Build Static Sites (CLI)

```bash
npx nlpwa add push --dir ./public
```

Places:
- `public/plugins/push.sw.js` — IIFE Service Worker script (`window.NLPWAPushSW`).
- `public/plugins/push.client.js` — IIFE Client script (`window.NLPWAPushClient`).

---

## Client-Side Usage

```javascript
import { pushClient } from 'nlpwa/push/client';

async function initPush() {
  // 1. Check capability
  if (!pushClient.isSupported()) {
    console.log('Web Push is not supported in this browser.');
    return;
  }

  // 2. Subscribe with your VAPID public key
  const result = await pushClient.subscribe({
    vapidPublicKey: 'BEl62iUYg...YOUR_VAPID_PUBLIC_KEY',
    userVisibleOnly: true,
  });

  if (result.success) {
    console.log('Subscribed to push:', result.subscription);
    // Send subscription JSON to your backend server
    await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.json),
    });
  } else if (result.reason === 'permission_denied') {
    console.warn('User denied notification permissions.');
  }
}

// Unsubscribe when user opts out
async function disablePush() {
  const unsubscribed = await pushClient.unsubscribe();
  if (unsubscribed) {
    console.log('Push subscription removed.');
  }
}
```

---

## Service Worker Configuration

Attach `PushPlugin` to your Service Worker initialization:

```javascript
// sw.js
import { initSW } from 'nlpwa/sw';
import { PushPlugin } from 'nlpwa/push/sw';

const push = new PushPlugin({
  defaultUrl: '/inbox',
  actions: {
    'view-order': (event) => {
      console.log('User clicked "View Order" action button');
    },
    'dismiss': (event) => {
      event.notification.close();
    },
  },
  onPush: (event, payload) => {
    console.log('Received push payload:', payload);
  },
});

initSW({
  plugins: [push],
});
```

### Notification Click & Window Routing Behavior

- **URL Resolution**: `focusOrOpenUrl(url)` resolves relative paths (e.g. `'/'` or `'/inbox'`) against `self.location.origin` before checking open window clients. If an existing window matching the target URL is already open, it is focused; otherwise, a new window is opened.
- **Action Handlers (`actions`)**: When an action button is clicked and a matching handler in `actions` is defined, the handler executes (synchronously or asynchronously) and completes the interaction. It will **not** fall through to open the default window. If an action handler wants to open or focus a window, it can explicitly call `focusOrOpenUrl(url)`.
- **Custom Click Handler (`onNotificationClick`)**: When a custom click handler is specified, it handles notification interactions without falling through to open the default window. Call `focusOrOpenUrl(url)` within your handler if opening or focusing a window is desired.
- **Default Fallback**: If neither a matching action handler nor `onNotificationClick` is provided, clicking the notification automatically calls `focusOrOpenUrl(event.notification.data?.url || defaultUrl)`.

---

## Push Payload Format

When your backend sends Web Push payloads via WebPush/VAPID, format the JSON payload as:

```json
{
  "title": "New Order Placed",
  "body": "Order #4521 has been confirmed.",
  "icon": "/assets/icon-192.png",
  "badge": "/assets/badge-96.png",
  "data": {
    "url": "/orders/4521"
  },
  "actions": [
    { "action": "view-order", "title": "View Order" },
    { "action": "dismiss", "title": "Dismiss" }
  ]
}
```

---

## API Reference

### Client API (`nlpwa/push/client`)

| Function / Class | Description |
|---|---|
| `isPushSupported()` | Returns `true` if `PushManager`, `Notification`, and `serviceWorker` are available. |
| `getPushPermission()` | Returns current permission: `'granted'`, `'denied'`, `'default'`, or `'unsupported'`. |
| `urlBase64ToUint8Array(base64)` | Converts URL-safe base64 VAPID public key string into a `Uint8Array`. |
| `subscribePush(options)` | Requests permission, converts key, and returns `{ success, subscription, json, permission }`. |
| `unsubscribePush(options)` | Unsubscribes active push subscription. |
| `getPushSubscription(options)` | Returns active `PushSubscription` or `null`. |
| `pushClient` | Singleton instance of `PushClient`. |

### Service Worker API (`nlpwa/push/sw`)

| Class | Description |
|---|---|
| `PushPlugin` | Service Worker plugin handling `push` and `notificationclick` events. |
| `focusOrOpenUrl(url)` | Helper that focuses an existing window matching `url` or opens a new window. |
