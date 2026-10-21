import {
  SHARE_CACHE_NAME,
  SHARE_QUEUE_KEY,
  DEFAULT_MAX_FILE_BYTES,
  SHARE_MESSAGE_TYPES,
} from './constants.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('NLPWA:Share');

export { SHARE_CACHE_NAME, SHARE_QUEUE_KEY, DEFAULT_MAX_FILE_BYTES, SHARE_MESSAGE_TYPES };

/**
 * Check if a request matches the configured Web Share Target action.
 *
 * @param {Request} request
 * @param {Object} [config]
 * @returns {boolean}
 */
export function isShareTargetRequest(request, config = {}) {
  let shareConfig = config.shareTarget || config.share_target;
  if (!shareConfig && Array.isArray(config.plugins)) {
    const plugin = config.plugins.find(
      (p) => p && (p instanceof ShareTargetPlugin || p.isShareTargetPlugin || p.constructor?.name === 'ShareTargetPlugin' || p.options?.action)
    );
    if (plugin) {
      shareConfig = plugin.options || {};
    }
  }
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
 * Read the current pending share queue from cache.
 *
 * @param {Cache} cache
 * @returns {Promise<string[]>}
 */
async function getShareQueue(cache) {
  try {
    const resp = await cache.match(SHARE_QUEUE_KEY);
    if (!resp) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

/**
 * Save the pending share queue to cache.
 *
 * @param {Cache} cache
 * @param {string[]} queue
 */
async function saveShareQueue(cache, queue) {
  await cache.put(
    new Request(SHARE_QUEUE_KEY),
    new Response(JSON.stringify(queue), {
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

/**
 * Handle incoming Web Share Target submission.
 * Extracts title, text, url, and stores individual binary files directly as
 * separate native Response objects in Cache Storage to prevent memory exhaustion.
 * Adds the share to a FIFO queue and issues an HTTP 303 See Other redirect.
 *
 * @param {FetchEvent} event
 * @param {Object} [config]
 * @returns {Promise<Response>}
 */
export async function handleShareTarget(event, config = {}) {
  const request = event?.request || (event instanceof Request ? event : null);
  if (!request) {
    throw new TypeError('[NLPWA:Share] handleShareTarget requires an event or Request.');
  }
  const shareConfig = config.shareTarget || config.share_target || {};
  const redirectUrl = shareConfig.redirectUrl || '/?shared=1';
  const maxFileBytes = Number(shareConfig.maxFileBytes) || DEFAULT_MAX_FILE_BYTES;

  const shareId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sharedData = {
    id: shareId,
    title: '',
    text: '',
    url: '',
    files: [],
    timestamp: Date.now(),
  };

  try {
    let cache = null;
    if (typeof caches !== 'undefined') {
      cache = await caches.open(SHARE_CACHE_NAME);
    }

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
      let fileIdx = 0;
      for (const item of fileEntries) {
        if (!item || typeof item !== 'object' || !item.name) continue;

        const size = Number(item.size) || 0;
        if (size > maxFileBytes) {
          logger.warn(`[NLPWA] Shared file "${item.name}" exceeds limit (${(size / 1024 / 1024).toFixed(1)} MB > ${(maxFileBytes / 1024 / 1024).toFixed(1)} MB). Skipped.`);
          sharedData.files.push({
            name: item.name,
            type: item.type || 'application/octet-stream',
            size,
            error: 'FILE_TOO_LARGE',
          });
          continue;
        }

        const fileKey = `https://nlpwa.internal/_nlpwa_share/files/${shareId}/${fileIdx++}`;

        try {
          if (cache) {
            const fileResponse = new Response(item, {
              headers: {
                'Content-Type': item.type || 'application/octet-stream',
                'X-File-Name': encodeURIComponent(item.name),
                'X-File-Size': String(size),
              },
            });
            await cache.put(new Request(fileKey), fileResponse);
          }

          sharedData.files.push({
            name: item.name,
            type: item.type || 'application/octet-stream',
            size,
            lastModified: item.lastModified,
            url: fileKey,
          });
        } catch (fileErr) {
          logger.warn(`[NLPWA] Error storing shared file "${item.name}":`, fileErr?.message || fileErr);
          sharedData.files.push({
            name: item.name,
            type: item.type || 'application/octet-stream',
            size,
            error: fileErr?.message || 'READ_FAILED',
          });
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

    if (cache) {
      const recordKey = `https://nlpwa.internal/_nlpwa_share/records/${shareId}`;
      await cache.put(
        new Request(recordKey),
        new Response(JSON.stringify(sharedData), {
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const queue = await getShareQueue(cache);
      queue.push(shareId);
      await saveShareQueue(cache, queue);
    }

    if (typeof self !== 'undefined' && self.clients && typeof self.clients.matchAll === 'function') {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({
          type: SHARE_MESSAGE_TYPES.SHARED_DATA,
          data: sharedData,
        });
      }
    }
  } catch (err) {
    logger.warn('[NLPWA] Share target handling error:', err?.message || err);
  }

  const targetUrl = new URL(redirectUrl, request.url).href;
  return Response.redirect(targetUrl, 303);
}

/**
 * Retrieve and consume the next shared data item from the FIFO queue.
 *
 * @returns {Promise<Object|null>}
 */
export async function getLatestSharedData() {
  if (typeof caches === 'undefined') return null;

  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const queue = await getShareQueue(cache);
    if (!queue || queue.length === 0) return null;

    const shareId = queue.shift();
    await saveShareQueue(cache, queue);

    const recordKey = `https://nlpwa.internal/_nlpwa_share/records/${shareId}`;
    const recordResp = await cache.match(recordKey);
    if (!recordResp) return null;

    const data = await recordResp.json();
    await cache.delete(recordKey);

    if (Array.isArray(data.files)) {
      for (const file of data.files) {
        if (file.url) {
          try {
            const fileResp = await cache.match(file.url);
            if (fileResp) {
              file.blob = await fileResp.blob();
              await cache.delete(file.url);
            }
          } catch (fileErr) {
            logger.warn(`[NLPWA] Failed to hydrate shared file "${file.name}":`, fileErr?.message || fileErr);
            file.error = fileErr?.message || 'HYDRATION_FAILED';
          }
        }
      }
    }

    return data;
  } catch (err) {
    logger.warn('[NLPWA] Error retrieving shared data from queue:', err?.message || err);
    return null;
  }
}

/**
 * Web Share Target Service Worker Plugin.
 */
export class ShareTargetPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  async requestWillFetch({ request, event }) {
    if (isShareTargetRequest(request, { shareTarget: this.options })) {
      return handleShareTarget(event || request, { shareTarget: this.options });
    }
  }
}
