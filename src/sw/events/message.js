import { MESSAGE_TYPES } from '../../shared/constants.js';
import { checkForUpdate, getUpdateStatus } from '../update/index.js';
import { commitIfReady } from '../update/commit.js';
import { getStorageQuotaInfo, cleanRuntimeCache } from '../cache/cleanup.js';
import {
  getActive,
  getActiveName,
  getStaged,
  pinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
} from '../cache/store.js';

/**
 * Service Worker postMessage event handler.
 *
 * @param {Object} config
 * @returns {(event: ExtendableMessageEvent) => void}
 */
export function handleMessage(config) {
  return (event) => {
    const port = event.ports?.[0];
    const reply = (replyType, data, error) => {
      const payload = {
        type: replyType,
        requestId: event.data?.requestId,
        data: data ?? null,
        error: error ? (error.message || String(error)) : undefined,
      };
      if (port) {
        port.postMessage(payload);
      } else {
        event.source?.postMessage(payload);
      }
    };

    switch (event.data?.type) {
      case MESSAGE_TYPES.CHECK_UPDATE:
        event.waitUntil((async () => {
          try {
            const result = await checkForUpdate({ force: true });
            reply(MESSAGE_TYPES.CHECK_UPDATE, { result });
          } catch (err) {
            reply(MESSAGE_TYPES.CHECK_UPDATE, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.APPLY_UPDATE:
        event.waitUntil((async () => {
          const applied = await commitIfReady(event).catch(() => false);
          reply(MESSAGE_TYPES.APPLY_UPDATE_RESULT, { applied });
        })());
        break;

      case MESSAGE_TYPES.GET_CACHE_INFO:
        event.waitUntil((async () => {
          try {
            const info = await getStorageQuotaInfo();
            reply(MESSAGE_TYPES.CACHE_INFO, info);
          } catch (err) {
            reply(MESSAGE_TYPES.CACHE_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.CLEANUP_RUNTIME:
        event.waitUntil((async () => {
          try {
            const result = await cleanRuntimeCache(event.data?.options || {});
            reply(MESSAGE_TYPES.RUNTIME_CLEANED, result);
          } catch (err) {
            reply(MESSAGE_TYPES.RUNTIME_CLEANED, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.PIN_CLIENT:
        event.waitUntil((async () => {
          const clientId = event.source?.id;
          if (clientId) {
            const active = await getActive();
            const cacheName = event.data?.cache || (await getActiveName(config.caches.offline));
            const version = event.data?.version || active?.version || null;
            await pinClient(clientId, cacheName, version);
            reply(MESSAGE_TYPES.CLIENT_PINNED, { clientId, cache: cacheName, version });
          }
        })());
        break;

      case MESSAGE_TYPES.GET_VERSION:
        event.waitUntil((async () => {
          try {
            const active = await getActive();
            const staged = await getStaged();
            const clientId = event.source?.id;
            const pinnedCache = clientId ? getClientPinnedCache(clientId) : null;
            let pinnedVersion = clientId ? getClientPinnedVersion(clientId) : null;
            if (!pinnedVersion && pinnedCache) {
              const atIndex = pinnedCache.indexOf('@');
              if (atIndex !== -1) {
                const afterAt = pinnedCache.slice(atIndex + 1);
                const lastHyphen = afterAt.lastIndexOf('-');
                if (lastHyphen !== -1 && afterAt.length - lastHyphen === 5) {
                  pinnedVersion = afterAt.slice(0, lastHyphen);
                } else {
                  pinnedVersion = afterAt;
                }
              } else {
                pinnedVersion = active?.version || null;
              }
            }
            reply(MESSAGE_TYPES.VERSION_INFO, {
              activeVersion: active?.version || null,
              stagedVersion: staged?.complete ? staged.version : null,
              swVersion: config.version,
              pinnedCache: pinnedCache || active?.cache || null,
              pinnedVersion: pinnedVersion || active?.version || null,
            });
          } catch (err) {
            reply(MESSAGE_TYPES.VERSION_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.GET_STATUS:
        event.waitUntil((async () => {
          try {
            const status = await getUpdateStatus();
            reply(MESSAGE_TYPES.STATUS_INFO, { status });
          } catch (err) {
            reply(MESSAGE_TYPES.STATUS_INFO, null, err);
          }
        })());
        break;
    }
  };
}
