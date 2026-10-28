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
 * Checks whether a hostname qualifies as a local development host.
 * Matches localhost, loopback addresses (127.0.0.0/8, ::1, [::1]),
 * mDNS .local domains, and private LAN IP ranges (10.0.0.0/8, 172.16-31.x.x, 192.168.0.0/16).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isDevHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}

/**
 * Check if development / UI design mode is active (synchronous check).
 *
 * Checks in priority order:
 * 1. Window global: window.NLPWA_DEV === true (or "true")
 * 2. Script tag attribute: <script src="client.js" data-dev="true"> or data-dev
 * 3. URL query flag (?nlpwa_dev=1 / ?nlpwa_dev=0) and saved localStorage.nlpwa_dev
 *    (safeguarded to dev hosts only: localhost, 127.0.0.1, [::1], *.local, private LAN IPs)
 *
 * @param {HTMLScriptElement} [script]
 * @returns {boolean}
 */
export function isDevMode(script) {
  // 1. Global window.NLPWA_DEV (works everywhere)
  if (typeof window !== 'undefined' && isDevFlag(window.NLPWA_DEV)) {
    return true;
  }

  // 2. Script tag attribute: data-dev, data-dev="true" (works everywhere)
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

  // Fallback DOM scan in case el didn't have data-dev
  if (typeof document !== 'undefined' && document.querySelector) {
    const devScript = document.querySelector('script[data-dev]');
    if (devScript) {
      const devAttr = devScript.getAttribute('data-dev');
      if (isDevFlag(devAttr)) {
        return true;
      }
    }
  }

  // 3. URL parameter & persisted localStorage (only on dev hosts: localhost, 127.0.0.1, LAN)
  if (typeof window !== 'undefined') {
    const host = window.location?.hostname || (typeof location !== 'undefined' ? location.hostname : '');
    if (isDevHost(host)) {
      try {
        let hasDevQuery = false;
        let isDevQueryActive = false;

        const search = window.location?.search;
        if (search) {
          const params = new URLSearchParams(search);
          const devParam = params.get('nlpwa_dev');
          if (devParam !== null) {
            hasDevQuery = true;
            if (devParam === '1' || devParam === 'true') {
              isDevQueryActive = true;
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('nlpwa_dev', '1');
              }
            } else if (devParam === '0' || devParam === 'false') {
              if (typeof localStorage !== 'undefined') {
                localStorage.removeItem('nlpwa_dev');
              }
            }
          }
        }

        if (isDevQueryActive) {
          return true;
        }

        // If no explicit nlpwa_dev query parameter, check previously saved localStorage flag
        if (!hasDevQuery && typeof localStorage !== 'undefined') {
          if (localStorage.getItem('nlpwa_dev') === '1') {
            return true;
          }
        }
      } catch {}
    }
  }

  return false;
}
