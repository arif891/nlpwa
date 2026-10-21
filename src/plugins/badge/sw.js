/**
 * Clear application badge on notification click.
 *
 * @param {NotificationEvent} event
 */
export function clearBadgeOnNotificationClick(event) {
  if (typeof navigator !== 'undefined' && typeof navigator.clearAppBadge === 'function') {
    event.waitUntil(navigator.clearAppBadge().catch(() => {}));
  }
}

/**
 * Update application badge from incoming push payload.
 *
 * @param {PushEvent} event
 * @param {Object} payload
 */
export function setBadgeFromPush(event, payload) {
  if (payload?.badge !== undefined && typeof navigator !== 'undefined') {
    if (payload.badge === 0 || payload.badge === null) {
      if (typeof navigator.clearAppBadge === 'function') {
        event.waitUntil(navigator.clearAppBadge().catch(() => {}));
      }
    } else if (typeof navigator.setAppBadge === 'function') {
      event.waitUntil(navigator.setAppBadge(Number(payload.badge)).catch(() => {}));
    }
  }
}

/**
 * Service Worker Plugin for App Badging.
 */
export class BadgePlugin {
  constructor(options = {}) {
    this.clearOnClick = options.clearOnClick ?? true;
  }

  onNotificationClick(event) {
    if (this.clearOnClick) {
      clearBadgeOnNotificationClick(event);
    }
  }

  onPush(event, payload) {
    setBadgeFromPush(event, payload);
  }
}
