/**
 * Evaluates whether a flag value indicates development mode.
 * Accepts boolean true, 'true', 1, '1', or '' (for valueless boolean HTML attributes).
 * Explicitly rejects false, 'false', 0, '0', null, undefined, etc.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDevFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === '';
}
