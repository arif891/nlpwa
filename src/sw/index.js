import { initConfig } from './config/index.js';
import { handleFetch } from './fetch/index.js';
import {
  handleInstall,
  handleActivate,
  handleMessage,
  handlePush,
  handleNotificationClick,
  handleSync,
} from './events/index.js';

/**
 * Initialize the NLPWA Service Worker.
 *
 * @param {Object} [userConfig]
 */
export function initSW(userConfig = {}) {
  const config = initConfig(userConfig);

  // Wire Service Worker lifecycle and message events
  self.addEventListener('install', handleInstall(config));
  self.addEventListener('activate', handleActivate(config));
  self.addEventListener('fetch', handleFetch);
  self.addEventListener('message', handleMessage(config));
  self.addEventListener('periodicsync', handleSync);
  self.addEventListener('push', handlePush(config));
  self.addEventListener('notificationclick', handleNotificationClick(config));
}
