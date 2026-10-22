/**
 * Check if the Badging API is supported by the current browser environment.
 *
 * @returns {boolean}
 */
export function isBadgingSupported() {
  return typeof navigator !== 'undefined' && ('setAppBadge' in navigator || 'clearAppBadge' in navigator);
}

/**
 * Set the application badge count.
 * If count is undefined or null, an uncounted dot badge is set.
 * If count is 0, the badge is cleared.
 *
 * @param {number} [count] Badge count (positive integer) or undefined for dot
 * @returns {Promise<boolean>} True if set, false if unsupported or failed
 */
export async function setAppBadge(count) {
  if (typeof navigator !== 'undefined') {
    try {
      if (count === 0) {
        if (typeof navigator.clearAppBadge === 'function') {
          await navigator.clearAppBadge();
          return true;
        }
      }
      if (typeof navigator.setAppBadge === 'function') {
        if (count === undefined || count === null) {
          await navigator.setAppBadge();
        } else {
          await navigator.setAppBadge(Math.max(0, Math.floor(Number(count))));
        }
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Clear the application badge.
 *
 * @returns {Promise<boolean>} True if cleared, false if unsupported or failed
 */
export async function clearAppBadge() {
  if (typeof navigator !== 'undefined' && typeof navigator.clearAppBadge === 'function') {
    try {
      await navigator.clearAppBadge();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * App Badging Client Helper.
 */
export class BadgeClient {
  isSupported() {
    return isBadgingSupported();
  }

  set(count) {
    return setAppBadge(count);
  }

  clear() {
    return clearAppBadge();
  }
}

export const badgeClient = new BadgeClient();
