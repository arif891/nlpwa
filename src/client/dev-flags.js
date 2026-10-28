/**
 * Evaluates whether a flag value indicates development mode.
 * Accepts boolean true, 'true', or '' (for valueless boolean HTML attribute <script data-dev>).
 * Explicitly rejects 1, '1', false, 'false', 0, '0', null, undefined, etc.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDevFlag(value) {
  return value === true || value === 'true' || value === '';
}
