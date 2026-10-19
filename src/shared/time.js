/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: '7d', '24h', '30m', '60s', '500ms', or plain numbers (ms).
 *
 * @param {string|number} [val]
 * @returns {number|null}
 */
export function parseDurationMs(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    return val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    const unit = match[2] || 'ms';
    if (unit === 'w') return Math.round(num * 7 * 24 * 60 * 60 * 1000);
    if (unit === 'd') return Math.round(num * 24 * 60 * 60 * 1000);
    if (unit === 'h') return Math.round(num * 60 * 60 * 1000);
    if (unit === 'm') return Math.round(num * 60 * 1000);
    if (unit === 's') return Math.round(num * 1000);
    return Math.round(num);
  }
  return null;
}

/**
 * Resolve max age in milliseconds from route options.
 *
 * @param {Object} [options]
 * @returns {number|null}
 */
export function resolveMaxAgeMs(options) {
  if (options?.maxAge != null) return parseDurationMs(options.maxAge);
  return null;
}

/**
 * Check if a cached Response has expired based on its cached timestamp and maxAgeMs.
 *
 * @param {Response} response
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function isResponseExpired(response, maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0 || !response) return false;
  const cachedAtHeader = response.headers?.get('X-NLPWA-Cached-At');
  let cachedAt = 0;
  if (cachedAtHeader) {
    const parsed = parseInt(cachedAtHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
  } else {
    const dateHeader = response.headers?.get('Date');
    if (dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (!Number.isNaN(parsed) && parsed > 0) cachedAt = parsed;
    }
  }
  if (!cachedAt) return false;
  return (Date.now() - cachedAt) > maxAgeMs;
}
