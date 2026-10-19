import { createLogger } from '../shared/logger.js';

let _logLevel = 'info';

/**
 * Set the client-side log level ('silent' | 'error' | 'warn' | 'info' | 'debug').
 *
 * @param {string} level
 */
export function setClientLogLevel(level) {
  if (level && typeof level === 'string') {
    _logLevel = level;
  }
}

/**
 * Get current client log level.
 *
 * @returns {string}
 */
export function getClientLogLevel() {
  return _logLevel;
}

export const logger = createLogger(() => ({ logLevel: _logLevel }));
export default logger;
