import { logger } from '../logger.js';
import { checkForUpdate } from '../update/index.js';

/**
 * Handle push events (silent updates and visible notifications).
 *
 * @param {Object} [userConfig]
 * @returns {(event: PushEvent) => void}
 */
export function handlePush(userConfig = {}) {
  return (event) => {
    if (typeof userConfig.onPush === 'function') {
      try {
        const customRes = userConfig.onPush(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          return;
        }
      } catch (err) {
        logger.warn('[NLPWA] onPush handler error:', err?.message || err);
      }
    }

    if (!event.data) return;

    event.waitUntil((async () => {
      try {
        let payload;
        try {
          payload = event.data.json();
        } catch {
          payload = { body: event.data.text() };
        }

        // Silent background update trigger via Push
        if (payload?.type === 'CHECK_UPDATE' || payload?.nlpwa === 'check-update') {
          await checkForUpdate({ force: true });
          return;
        }

        // Set or clear app badge if specified in push payload
        if (payload?.badge !== undefined && typeof navigator !== 'undefined') {
          if (payload.badge === 0 || payload.badge === null) {
            if (typeof navigator.clearAppBadge === 'function') {
              await navigator.clearAppBadge().catch(() => {});
            }
          } else if (typeof navigator.setAppBadge === 'function') {
            await navigator.setAppBadge(Number(payload.badge)).catch(() => {});
          }
        }

        if (typeof self !== 'undefined' && payload?.title && self.registration && typeof self.registration.showNotification === 'function') {
          const { title, ...options } = payload;
          await self.registration.showNotification(title, options);
        }
      } catch (err) {
        logger.warn('[NLPWA] Push handling error:', err?.message || err);
      }
    })());
  };
}

/**
 * Handle notification clicks.
 *
 * @param {Object} [userConfig]
 * @returns {(event: NotificationEvent) => void}
 */
export function handleNotificationClick(userConfig = {}) {
  return (event) => {
    if (typeof userConfig.onNotificationClick === 'function') {
      try {
        const customRes = userConfig.onNotificationClick(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          return;
        }
      } catch (err) {
        logger.warn('[NLPWA] onNotificationClick handler error:', err?.message || err);
      }
    }

    event.notification.close();

    // Clear application badge when notification is clicked unless opted out
    if (userConfig.clearBadgeOnClick !== false && typeof navigator !== 'undefined' && typeof navigator.clearAppBadge === 'function') {
      navigator.clearAppBadge().catch(() => {});
    }

    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil((async () => {
      if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }
    })());
  };
}
