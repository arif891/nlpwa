# OS App Badging Plugin (`nlpwa/badge`)

Controls the app icon badge count across Windows, macOS, Android, and iOS, with optional automatic clearance when users click incoming Web Push notifications.

---

## Service Worker Configuration

Import and register `BadgePlugin` in `sw.js`:

```javascript
import { initSW } from 'nlpwa/sw';
import { BadgePlugin } from 'nlpwa/badge';

initSW({
  plugins: [
    new BadgePlugin({
      // Automatically clear badge when user taps a push notification (default: true)
      clearOnClick: true,
    }),
  ],
});
```

---

## Client SDK Usage

```javascript
import { setBadge, clearBadge, isBadgeSupported } from 'nlpwa/badge';

// Check browser support
if (isBadgeSupported()) {
  // Set badge to specific count
  await setBadge(5);

  // Set indeterminate badge (dot)
  await setBadge();

  // Clear badge
  await clearBadge();
}
```

### Automatic Push Badge Updates

If your push server includes a `badge` property in the push payload:

```json
{
  "title": "New Message",
  "body": "You have 3 unread messages",
  "badge": 3
}
```

The Service Worker automatically calls `navigator.setAppBadge(3)` upon push arrival, and `navigator.clearAppBadge()` when the notification is tapped.
