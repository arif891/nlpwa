import { logger } from '../logger.js';

export const SHARE_CACHE_NAME = 'nlpwa-share-target';
export const SHARE_RECORD_KEY = 'https://nlpwa.internal/_nlpwa_share/latest';

/**
 * Check if a request matches the configured Web Share Target action.
 *
 * @param {Request} request
 * @param {Object} [config]
 * @returns {boolean}
 */
export function isShareTargetRequest(request, config = {}) {
  const shareConfig = config.shareTarget || config.share_target;
  if (!shareConfig) return false;

  const action = shareConfig.action || '/_share-target';
  try {
    const url = new URL(request.url);
    return url.pathname === action;
  } catch {
    return false;
  }
}

/**
 * Handle incoming Web Share Target submission.
 * Extracts title, text, url, and files, stores the payload in offline cache,
 * broadcasts it to open clients if available, and issues a 303 redirect.
 *
 * @param {FetchEvent} event
 * @param {Object} [config]
 * @returns {Promise<Response>}
 */
export async function handleShareTarget(event, config = {}) {
  const { request } = event;
  const shareConfig = config.shareTarget || config.share_target || {};
  const redirectUrl = shareConfig.redirectUrl || '/?shared=1';

  const sharedData = {
    title: '',
    text: '',
    url: '',
    files: [],
    timestamp: Date.now(),
  };

  try {
    if (request.method === 'POST') {
      const formData = await request.formData();
      const titleParam = shareConfig.params?.title || 'title';
      const textParam = shareConfig.params?.text || 'text';
      const urlParam = shareConfig.params?.url || 'url';
      const filesParam = shareConfig.params?.files?.[0]?.name || 'files';

      sharedData.title = String(formData.get(titleParam) || '');
      sharedData.text = String(formData.get(textParam) || '');
      sharedData.url = String(formData.get(urlParam) || '');

      const fileEntries = formData.getAll(filesParam);
      for (const item of fileEntries) {
        if (item && typeof item === 'object' && item.name) {
          try {
            const buffer = await item.arrayBuffer();
            sharedData.files.push({
              name: item.name,
              type: item.type,
              size: item.size,
              lastModified: item.lastModified,
              data: Array.from(new Uint8Array(buffer)),
            });
          } catch {}
        }
      }
    } else {
      const url = new URL(request.url);
      const titleParam = shareConfig.params?.title || 'title';
      const textParam = shareConfig.params?.text || 'text';
      const urlParam = shareConfig.params?.url || 'url';

      sharedData.title = url.searchParams.get(titleParam) || '';
      sharedData.text = url.searchParams.get(textParam) || '';
      sharedData.url = url.searchParams.get(urlParam) || '';
    }

    // Persist in cache so the client can retrieve it upon landing on redirectUrl
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(SHARE_CACHE_NAME);
      await cache.put(
        new Request(SHARE_RECORD_KEY),
        new Response(JSON.stringify(sharedData), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // Broadcast to open client windows if any
    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: 'SHARED_DATA',
          data: sharedData,
        });
      }
    }
  } catch (err) {
    logger.warn('[NLPWA] Share target handling error:', err?.message || err);
  }

  // Issue HTTP 303 See Other redirect to application UI
  const targetUrl = new URL(redirectUrl, request.url).href;
  return Response.redirect(targetUrl, 303);
}

/**
 * Retrieve and clear the latest stored shared data.
 *
 * @returns {Promise<Object|null>}
 */
export async function getLatestSharedData() {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const resp = await cache.match(SHARE_RECORD_KEY);
    if (!resp) return null;
    const data = await resp.json();
    await cache.delete(SHARE_RECORD_KEY);
    return data;
  } catch {
    return null;
  }
}
