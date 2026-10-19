import { matchGlob } from '../../shared/glob.js';

/**
 * Standard tracking query parameters stripped by default to avoid cache fragmentation.
 * Includes Google Analytics, Facebook, Microsoft Bing, HubSpot, Mailchimp, and generic ref.
 */
export const DEFAULT_IGNORE_SEARCH_PARAMS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^msclkid$/,
  /^dclid$/,
  /^_hsenc$/,
  /^_hsmi$/,
  /^ref$/,
  /^mc_cid$/,
  /^mc_eid$/,
];

/**
 * Strip tracking query parameters matching ignoreURLParametersMatching patterns.
 *
 * @param {string|Request} requestOrUrl
 * @param {Array<string|RegExp>} [ignorePatterns]
 * @returns {string} clean URL string
 */
export function cleanTrackingParams(requestOrUrl, ignorePatterns = DEFAULT_IGNORE_SEARCH_PARAMS) {
  const urlStr = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
  let parsed;
  try {
    parsed = new URL(urlStr, 'http://localhost');
  } catch {
    return urlStr;
  }

  if (!parsed.search) return urlStr;
  if (!Array.isArray(ignorePatterns) || ignorePatterns.length === 0) return urlStr;

  let changed = false;
  const keys = [...parsed.searchParams.keys()];

  for (const key of keys) {
    for (const pattern of ignorePatterns) {
      const matches = pattern instanceof RegExp
        ? pattern.test(key)
        : pattern === key || matchGlob(pattern, key);
      if (matches) {
        parsed.searchParams.delete(key);
        changed = true;
        break;
      }
    }
  }

  if (!changed) return urlStr;

  if (typeof requestOrUrl === 'string' && !requestOrUrl.startsWith('http://') && !requestOrUrl.startsWith('https://')) {
    return parsed.pathname + (parsed.search ? parsed.search : '') + (parsed.hash ? parsed.hash : '');
  }

  return parsed.href;
}
