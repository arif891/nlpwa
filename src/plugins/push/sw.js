import { PUSH_CONSTANTS } from './constants.js';

/**
 * Focus an existing open window client matching targetUrl, or open a new window.
 *
 * @param {string} targetUrl
 * @returns {Promise<WindowClient|null>}
 */
export async function focusOrOpenUrl(targetUrl = PUSH_CONSTANTS.DEFAULT_NOTIFICATION_URL) {
  if (typeof self === 'undefined' || !self.clients || typeof self.clients.matchAll !== 'function') {
    return null;
  }

  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windowClients) {
    if (client.url === targetUrl && 'focus' in client) {
      return await client.focus();
    }
  }

  if (self.clients.openWindow) {
    return await self.clients.openWindow(targetUrl);
  }
  return null;
}

/**
 * Service Worker Plugin for Push Notifications & Interactive Action Handling.
 */
export class PushPlugin {
  /**
   * @param {Object} [options]
   * @param {(event: PushEvent, payload: Object) => Promise<any>|void} [options.onPush] Custom push handler
   * @param {(event: NotificationEvent) => Promise<any>|void} [options.onNotificationClick] Custom click handler
   * @param {Record<string, (event: NotificationEvent) => Promise<any>|void>} [options.actions] Action handlers by action ID
   * @param {string} [options.defaultUrl='/'] Fallback URL when clicking notifications
   * @param {boolean} [options.showNotification=true] Whether to auto-display notifications when payload has title
   */
  constructor(options = {}) {
    this.customOnPush = typeof options.onPush === 'function' ? options.onPush : null;
    this.customOnClick = typeof options.onNotificationClick === 'function' ? options.onNotificationClick : null;
    this.actions = options.actions && typeof options.actions === 'object' ? options.actions : {};
    this.defaultUrl = options.defaultUrl || PUSH_CONSTANTS.DEFAULT_NOTIFICATION_URL;
    this.showNotification = options.showNotification ?? true;
  }

  /**
   * Called during the SW 'push' event by NLPWA SW engine.
   *
   * @param {PushEvent} event
   * @param {Object} [payload]
   */
  onPush(event, payload) {
    if (!payload && event?.data) {
      try {
        payload = event.data.json();
      } catch {
        payload = { body: event.data.text() };
      }
    }

    if (this.customOnPush) {
      try {
        const res = this.customOnPush(event, payload);
        if (res && typeof res.then === 'function') {
          event.waitUntil(res);
        }
      } catch (err) {
        console.warn?.('[NLPWA/push] custom onPush error:', err?.message || err);
      }
    }

    if (this.showNotification && payload?.title && typeof self !== 'undefined' && self.registration?.showNotification) {
      const { title, ...options } = payload;
      const notificationPromise = self.registration.showNotification(title, {
        ...options,
        data: {
          url: options.url || options.data?.url || this.defaultUrl,
          ...(options.data || {}),
        },
      });
      event.waitUntil(notificationPromise);
    }
  }

  /**
   * Called during the SW 'notificationclick' event by NLPWA SW engine.
   *
   * @param {NotificationEvent} event
   */
  onNotificationClick(event) {
    event.notification?.close();

    const action = event.action;
    if (action && typeof this.actions[action] === 'function') {
      try {
        const actionRes = this.actions[action](event);
        if (actionRes && typeof actionRes.then === 'function') {
          event.waitUntil(actionRes);
          return;
        }
      } catch (err) {
        console.warn?.(`[NLPWA/push] action handler for "${action}" error:`, err?.message || err);
      }
    }

    if (this.customOnClick) {
      try {
        const clickRes = this.customOnClick(event);
        if (clickRes && typeof clickRes.then === 'function') {
          event.waitUntil(clickRes);
          return;
        }
      } catch (err) {
        console.warn?.('[NLPWA/push] custom onNotificationClick error:', err?.message || err);
      }
    }

    const targetUrl = event.notification?.data?.url || this.defaultUrl;
    event.waitUntil(focusOrOpenUrl(targetUrl));
  }
}
