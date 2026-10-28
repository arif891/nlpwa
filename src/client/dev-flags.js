/**
 * Evaluates whether a flag value indicates development mode.
 * Accepts boolean true, 'true', or '' (for valueless boolean HTML attribute <script data-dev>).
 * Explicitly rejects false, 'false', 0, '0', null, undefined, etc.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDevFlag(value) {
  return value === true || value === 'true' || value === '';
}

/**
 * Check if development / UI design mode is active (synchronous check).
 *
 * Checks in priority order:
 * 1. Window global: window.NLPWA_DEV === true (or "true")
 * 2. Script tag attribute: <script src="client.js" data-dev="true"> or data-dev
 *
 * @param {HTMLScriptElement} [script]
 * @returns {boolean}
 */
export function isDevMode(script) {
  // 1. Global window.NLPWA_DEV
  if (typeof window !== 'undefined' && isDevFlag(window.NLPWA_DEV)) {
    return true;
  }

  // 2. Script tag attribute: data-dev, data-dev="true"
  const el = script || (typeof document !== 'undefined' && (
    document.currentScript ||
    document.querySelector?.('script[data-dev]')
  ));

  if (el) {
    const devAttr = el.getAttribute?.('data-dev');
    if (devAttr !== null && devAttr !== undefined) {
      if (isDevFlag(devAttr)) {
        return true;
      }
    }
  }

  return false;
}
