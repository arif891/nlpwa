import { checkForUpdate } from '../update/index.js';

/**
 * Handle periodic background sync events.
 *
 * @param {Event} event
 */
export function handleSync(event) {
  if (event.tag === 'nlpwa-update-check') {
    event.waitUntil(checkForUpdate());
  }
}
