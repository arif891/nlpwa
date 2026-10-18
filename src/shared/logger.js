const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Create a logger instance bound to a config accessor function.
 *
 * @param {Function} [getConfigFn]
 * @returns {{
 *   error: (...args: any[]) => void,
 *   warn: (...args: any[]) => void,
 *   log: (...args: any[]) => void,
 *   info: (...args: any[]) => void,
 *   debug: (...args: any[]) => void,
 * }}
 */
export function createLogger(getConfigFn) {
  function getLevel() {
    try {
      const config = typeof getConfigFn === 'function' ? getConfigFn() : null;
      const level = config?.logLevel;
      if (typeof level === 'string' && level in LOG_LEVELS) {
        return LOG_LEVELS[level];
      }
      return LOG_LEVELS.info;
    } catch {
      return LOG_LEVELS.info;
    }
  }

  return {
    error(...args) {
      if (getLevel() >= LOG_LEVELS.error) console.error(...args);
    },
    warn(...args) {
      if (getLevel() >= LOG_LEVELS.warn) console.warn(...args);
    },
    log(...args) {
      if (getLevel() >= LOG_LEVELS.info) console.log(...args);
    },
    info(...args) {
      if (getLevel() >= LOG_LEVELS.info) console.info(...args);
    },
    debug(...args) {
      if (getLevel() >= LOG_LEVELS.debug) console.debug(...args);
    },
  };
}
