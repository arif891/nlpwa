export const BG_FETCH_CACHE_NAME = 'runtime';
export const BG_FETCH_ID_PREFIX = 'nlpwa-bg:';

export const BG_FETCH_MESSAGE_TYPES = {
  BG_FETCH_SUCCESS: 'BG_FETCH_SUCCESS',
  BG_FETCH_FAIL: 'BG_FETCH_FAIL',
  BG_FETCH_ABORT: 'BG_FETCH_ABORT',
  BG_FETCH_CLICK: 'BG_FETCH_CLICK',
};

/**
 * Generate a deterministic Background Fetch ID for a given URL pathname.
 *
 * @param {string} url
 * @returns {string}
 */
export function getBgFetchIdForUrl(url) {
  return `${BG_FETCH_ID_PREFIX}${encodeURIComponent(url)}`;
}

/**
 * Extract the URL pathname from a deterministic Background Fetch ID if applicable.
 *
 * @param {string} id
 * @returns {string|null}
 */
export function getUrlFromBgFetchId(id) {
  if (typeof id === 'string' && id.startsWith(BG_FETCH_ID_PREFIX)) {
    try {
      return decodeURIComponent(id.slice(BG_FETCH_ID_PREFIX.length));
    } catch {
      return id.slice(BG_FETCH_ID_PREFIX.length);
    }
  }
  return null;
}
