import { getConfig } from '../../config/index.js';
import { cleanTrackingParams } from '../keys.js';

/**
 * Match a request against a cache with standard HTML, clean URLs, directory index, and base path aliases.
 *
 * @param {Cache} cache
 * @param {Request|string} request
 * @param {CacheQueryOptions} [matchOptions]
 * @param {string} [base]
 * @param {Object} [config]
 * @returns {Promise<Response|undefined>}
 */
export async function matchWithAliases(cache, request, matchOptions, base, config = getConfig()) {
  const rawUrl = typeof request === 'string' ? request : request.url;
  const ignorePatterns = config?.ignoreURLParametersMatching;
  const cleanedUrl = cleanTrackingParams(rawUrl, ignorePatterns);

  let hit;
  if (cleanedUrl !== rawUrl) {
    hit = await cache.match(cleanedUrl, matchOptions);
    if (!hit) {
      hit = await cache.match(request, matchOptions);
    }
  } else {
    hit = await cache.match(request, matchOptions);
  }
  if (hit) return hit;

  let pathname = null;
  try {
    pathname = new URL(cleanedUrl, 'https://example.com').pathname;
  } catch {}

  if (!pathname) return undefined;

  const directoryIndex = config?.directoryIndex ?? 'index.html';
  const cleanIndex = directoryIndex.startsWith('/') ? directoryIndex.slice(1) : directoryIndex;
  const cleanURLs = config?.cleanURLs !== false;

  // 1. Root / Directory index
  if (directoryIndex) {
    if (pathname === '/') {
      hit = await cache.match(`/${cleanIndex}`, matchOptions);
      if (hit) return hit;
    } else if (pathname === `/${cleanIndex}`) {
      hit = await cache.match('/', matchOptions);
      if (hit) return hit;
    } else if (pathname.endsWith('/')) {
      hit = await cache.match(`${pathname}${cleanIndex}`, matchOptions);
      if (hit) return hit;
    }
  }

  // 2. Clean URLs (e.g. /about -> /about.html)
  if (cleanURLs) {
    const lastSegment = pathname.split('/').pop() || '';
    if (lastSegment && !lastSegment.includes('.')) {
      hit = await cache.match(`${pathname}.html`, matchOptions);
      if (hit) return hit;
    }
  }

  // 3. Subpath base aliases
  if (base) {
    const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
    if (pathname === cleanBase || pathname === `${cleanBase}/`) {
      return (await cache.match(`${cleanBase}/${cleanIndex}`, matchOptions))
        ?? (await cache.match(`/${cleanIndex}`, matchOptions))
        ?? (await cache.match(cleanBase, matchOptions))
        ?? (await cache.match(`${cleanBase}/`, matchOptions));
    }
    if (pathname === `${cleanBase}/${cleanIndex}`) {
      return (await cache.match(`${cleanBase}/`, matchOptions))
        ?? (await cache.match(cleanBase, matchOptions))
        ?? (await cache.match(`/${cleanIndex}`, matchOptions));
    }
    if (cleanBase) {
      if (pathname.startsWith(cleanBase + '/')) {
        const withoutBase = pathname.slice(cleanBase.length);
        hit = await cache.match(withoutBase, matchOptions);
        if (hit) return hit;
      } else {
        const withBase = `${cleanBase}${pathname.startsWith('/') ? pathname : '/' + pathname}`;
        hit = await cache.match(withBase, matchOptions);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}
