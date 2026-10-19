import { tagResponse, CACHE_STATUS } from '../../cache/tag.js';
import { getPlugins } from '../plugins.js';
import { performFetch, getShouldThrow } from './context.js';

/**
 * Always fetch from network. Never read from or write to any cache.
 *
 * Best for: API mutations (POST, PUT, DELETE), authenticated endpoints.
 *
 * Response header: X-Cache-Status: network
 *
 * @param {Request} request
 * @param {FetchEvent} [event]
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function networkOnly(request, event, options = {}) {
  const plugins = getPlugins(options);
  try {
    const response = await performFetch(request, event, options, plugins);
    return tagResponse(response, CACHE_STATUS.NETWORK);
  } catch (err) {
    if (getShouldThrow(options)) {
      throw err;
    }
    return tagResponse(
      new Response('Offline — network request failed.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      CACHE_STATUS.OFFLINE_FALLBACK,
    );
  }
}
