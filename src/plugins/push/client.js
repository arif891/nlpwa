import { PUSH_PERMISSION_STATES, PUSH_CONSTANTS } from './constants.js';

/**
 * Convert a base64 or URL-safe base64 string to a Uint8Array (for VAPID applicationServerKey).
 *
 * @param {string} base64String
 * @returns {Uint8Array}
 */
export function urlBase64ToUint8Array(base64String) {
  if (typeof base64String !== 'string' || !base64String.trim()) {
    throw new TypeError('[NLPWA/push] VAPID public key must be a non-empty string.');
  }

  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  let rawData;
  if (typeof atob === 'function') {
    rawData = atob(base64);
  } else if (typeof Buffer !== 'undefined') {
    rawData = Buffer.from(base64, 'base64').toString('binary');
  } else {
    throw new Error('[NLPWA/push] Neither atob nor Buffer is available to decode VAPID key.');
  }

  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Check if Web Push and Notifications are supported in the current environment.
 *
 * @returns {boolean}
 */
export function isPushSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Get the current push notification permission status.
 *
 * @returns {NotificationPermission | 'unsupported'}
 */
export function getPushPermission() {
  if (!isPushSupported() || typeof Notification === 'undefined') {
    return PUSH_PERMISSION_STATES.UNSUPPORTED;
  }
  return Notification.permission;
}

/**
 * Retrieve the active Service Worker registration, using either a provided
 * registration instance or waiting for navigator.serviceWorker.ready.
 *
 * @param {ServiceWorkerRegistration} [registration]
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
async function resolveRegistration(registration) {
  if (registration) return registration;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Retrieve current push subscription if one exists.
 *
 * @param {Object} [options]
 * @param {ServiceWorkerRegistration} [options.registration]
 * @returns {Promise<PushSubscription|null>}
 */
export async function getPushSubscription(options = {}) {
  if (!isPushSupported()) return null;

  try {
    const reg = await resolveRegistration(options.registration);
    if (!reg?.pushManager) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Request notification permissions and subscribe to Web Push with progressive enhancement.
 *
 * @param {Object} options
 * @param {string} options.vapidPublicKey URL-safe Base64 VAPID public key
 * @param {boolean} [options.userVisibleOnly=true] Whether notifications are visible to the user
 * @param {ServiceWorkerRegistration} [options.registration] Optional existing SW registration
 * @returns {Promise<{ success: boolean, subscription?: PushSubscription, json?: Object, reason?: string, permission?: string, error?: Error }>}
 */
export async function subscribePush(options = {}) {
  if (!isPushSupported()) {
    return {
      success: false,
      reason: 'unsupported',
      permission: PUSH_PERMISSION_STATES.UNSUPPORTED,
    };
  }

  const {
    vapidPublicKey,
    userVisibleOnly = PUSH_CONSTANTS.DEFAULT_USER_VISIBLE,
    registration,
  } = options;

  if (!vapidPublicKey) {
    throw new Error('[NLPWA/push] vapidPublicKey is required to subscribe to push notifications.');
  }

  // 1. Request permission if not already granted
  let permission = Notification.permission;
  if (permission !== 'granted') {
    try {
      permission = await Notification.requestPermission();
    } catch (err) {
      return { success: false, reason: 'permission_error', error: err };
    }
  }

  if (permission !== 'granted') {
    return {
      success: false,
      reason: 'permission_denied',
      permission,
    };
  }

  // 2. Resolve Service Worker registration
  const reg = await resolveRegistration(registration);
  if (!reg || !reg.pushManager) {
    return {
      success: false,
      reason: 'sw_registration_unavailable',
    };
  }

  // 3. Subscribe with decoded applicationServerKey
  try {
    const convertedVapidKey = urlBase64ToUint8Array(vapidPublicKey);
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly,
      applicationServerKey: convertedVapidKey,
    });

    return {
      success: true,
      subscription,
      json: subscription.toJSON ? subscription.toJSON() : null,
      permission,
    };
  } catch (err) {
    return {
      success: false,
      reason: 'subscription_failed',
      error: err,
      permission,
    };
  }
}

/**
 * Unsubscribe from Web Push notifications.
 *
 * @param {Object} [options]
 * @param {ServiceWorkerRegistration} [options.registration]
 * @returns {Promise<boolean>} True if unsubscribed or no active subscription, false if failed
 */
export async function unsubscribePush(options = {}) {
  if (!isPushSupported()) return false;

  try {
    const reg = await resolveRegistration(options.registration);
    if (!reg?.pushManager) return false;

    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;

    return await sub.unsubscribe();
  } catch {
    return false;
  }
}

/**
 * Push Client Helper Class
 */
export class PushClient {
  constructor(options = {}) {
    this.defaultVapidKey = options.vapidPublicKey || null;
  }

  isSupported() {
    return isPushSupported();
  }

  getPermission() {
    return getPushPermission();
  }

  async getSubscription(options = {}) {
    return await getPushSubscription(options);
  }

  async subscribe(options = {}) {
    const vapidPublicKey = options.vapidPublicKey || this.defaultVapidKey;
    return await subscribePush({ ...options, vapidPublicKey });
  }

  async unsubscribe(options = {}) {
    return await unsubscribePush(options);
  }
}

export const pushClient = new PushClient();
