import { getConfig } from '../config/index.js';
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
    let activeConfig = {};
    try {
      activeConfig = getConfig() || {};
    } catch {
      activeConfig = {};
    }
    const effectiveConfig = { ...userConfig, ...activeConfig };
    const plugins = Array.isArray(activeConfig.plugins)
      ? activeConfig.plugins
      : (Array.isArray(userConfig.plugins) ? userConfig.plugins : []);

    let customHandled = false;
    if (typeof effectiveConfig.onPush === 'function') {
      try {
        const customRes = effectiveConfig.onPush(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          customHandled = true;
        }
      } catch (err) {
        logger.warn('[NLPWA] onPush handler error:', err?.message || err);
      }
    }

    let payload = null;
    if (event.data) {
      try {
        payload = event.data.json();
      } catch {
        payload = { body: event.data.text() };
      }
    }

    // Call onPush on plugins (e.g. BadgePlugin)
    for (const plugin of plugins) {
      if (typeof plugin?.onPush === 'function') {
        try {
          const res = plugin.onPush(event, payload);
          if (res && typeof res.then === 'function') {
            event.waitUntil(res);
          }
        } catch (err) {
          logger.warn('[NLPWA] plugin.onPush handler error:', err?.message || err);
        }
      }
    }

    if (customHandled || !payload) return;

    event.waitUntil((async () => {
      try {
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
    let activeConfig = {};
    try {
      activeConfig = getConfig() || {};
    } catch {
      activeConfig = {};
    }
    const effectiveConfig = { ...userConfig, ...activeConfig };
    const plugins = Array.isArray(activeConfig.plugins)
      ? activeConfig.plugins
      : (Array.isArray(userConfig.plugins) ? userConfig.plugins : []);

    let customHandled = false;
    if (typeof effectiveConfig.onNotificationClick === 'function') {
      try {
        const customRes = effectiveConfig.onNotificationClick(event);
        if (customRes && typeof customRes.then === 'function') {
          event.waitUntil(customRes);
          customHandled = true;
        }
      } catch (err) {
        logger.warn('[NLPWA] onNotificationClick handler error:', err?.message || err);
      }
    }

    for (const plugin of plugins) {
      if (typeof plugin?.onNotificationClick === 'function') {
        try {
          const res = plugin.onNotificationClick(event);
          if (res && typeof res.then === 'function') {
            event.waitUntil(res);
          }
        } catch (err) {
          logger.warn('[NLPWA] plugin.onNotificationClick handler error:', err?.message || err);
        }
      }
    }

    event.notification.close();

    // Clear application badge when notification is clicked unless opted out
    const clearBadge = effectiveConfig.clearBadgeOnClick !== false;
    if (clearBadge && typeof navigator !== 'undefined' && typeof navigator.clearAppBadge === 'function') {
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
