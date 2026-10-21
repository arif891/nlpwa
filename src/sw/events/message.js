import { MESSAGE_TYPES } from '../../shared/constants.js';
import { checkForUpdate, getUpdateStatus, isCommitDeferred } from '../update/index.js';
import { commitIfReady, rollbackToFallback } from '../update/commit.js';
import { getStorageQuotaInfo, cleanRuntimeCache } from '../cache/cleanup.js';
import {
  getActive,
  getActiveName,
  getStaged,
  pinClient,
  unpinClient,
  getClientPinnedCache,
  getClientPinnedVersion,
  getClientPinStatus,
  getMinVersion,
  getBlockedVersions,
  readMeta,
} from '../cache/store.js';
import { compare } from '../../shared/version.js';
import { getLatestSharedData } from '../features/share-target.js';

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

      case MESSAGE_TYPES.REPORT_BOOT_HEALTH:
        event.waitUntil((async () => {
          const active = await getActive();
          const version = event.data?.version || active?.version;
          reply(MESSAGE_TYPES.REPORT_BOOT_HEALTH, { healthy: true, version });
        })());
        break;

      case MESSAGE_TYPES.REPORT_BOOT_FAILURE:
        event.waitUntil((async () => {
          const error = event.data?.error || 'Boot failure reported by client';
          const triggerRollback = event.data?.rollback !== false;
          let rollbackResult = null;
          if (triggerRollback) {
            rollbackResult = await rollbackToFallback(error);
          }
          reply(MESSAGE_TYPES.REPORT_BOOT_FAILURE, {
            reported: true,
            rolledBack: Boolean(rollbackResult?.success),
            rollbackResult,
          });
        })());
        break;

      case MESSAGE_TYPES.TRIGGER_ROLLBACK:
        event.waitUntil((async () => {
          try {
            const reason = event.data?.reason || 'Manual rollback requested by client';
            const result = await rollbackToFallback(reason);
            reply(MESSAGE_TYPES.TRIGGER_ROLLBACK, result);
          } catch (err) {
            reply(MESSAGE_TYPES.TRIGGER_ROLLBACK, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.GET_BLOCKED_VERSIONS:
        event.waitUntil((async () => {
          try {
            const versions = await getBlockedVersions();
            reply(MESSAGE_TYPES.BLOCKED_VERSIONS_INFO, { versions });
          } catch (err) {
            reply(MESSAGE_TYPES.BLOCKED_VERSIONS_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.GET_DIAGNOSTICS:
        event.waitUntil((async () => {
          try {
            const active = await getActive();
            const staged = await getStaged();
            const blockedVersions = await getBlockedVersions();
            const storage = await getStorageQuotaInfo();
            const clientId = event.source?.id;
            const pinStatus = getClientPinStatus(clientId, { activeCache: active?.cache });
            const rollbackHistory = (await readMeta('/_nlpwa/rollback-history.json')) || [];
            const updateStatus = await getUpdateStatus();

            reply(MESSAGE_TYPES.DIAGNOSTICS_INFO, {
              active: active ? {
                version: active.version,
                cache: active.cache,
                fallbackVersion: active.fallbackVersion || null,
                fallbackCache: active.fallbackCache || null,
              } : null,
              staged: staged ? {
                version: staged.version,
                cache: staged.cache,
                complete: staged.complete,
                retryCount: staged.retryCount || 0,
                failedFiles: staged.failedFiles || [],
              } : null,
              pinStatus,
              blockedVersions,
              storage,
              rollbackHistory,
              updateStatus,
            });
          } catch (err) {
            reply(MESSAGE_TYPES.DIAGNOSTICS_INFO, null, err);
          }
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
            let cacheName = event.data?.cache;
            const offlinePrefix = `${config.caches.offline}@`;
            if (!cacheName || typeof cacheName !== 'string' || !cacheName.startsWith(offlinePrefix)) {
              cacheName = await getActiveName(config.caches.offline);
            }
            const version = event.data?.version || active?.version || null;
            await pinClient(clientId, cacheName, version);
            reply(MESSAGE_TYPES.CLIENT_PINNED, { clientId, cache: cacheName, version });
          }
        })());
        break;

      case MESSAGE_TYPES.UNPIN_CLIENT:
        event.waitUntil((async () => {
          const clientId = event.source?.id;
          if (clientId) {
            await unpinClient(clientId);
            reply(MESSAGE_TYPES.CLIENT_UNPINNED, { clientId });
          }
        })());
        break;

      case MESSAGE_TYPES.GET_PIN_STATUS:
        event.waitUntil((async () => {
          try {
            const clientId = event.source?.id;
            const active = await getActive();
            const status = getClientPinStatus(clientId, { activeCache: active?.cache });
            reply(MESSAGE_TYPES.PIN_STATUS_INFO, status);
          } catch (err) {
            reply(MESSAGE_TYPES.PIN_STATUS_INFO, null, err);
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
              if (active && pinnedCache === active.cache) {
                pinnedVersion = active.version;
              } else if (staged && pinnedCache === staged.cache) {
                pinnedVersion = staged.version;
              } else {
                pinnedVersion = active?.version || null;
              }
            }
            const minVersion = await getMinVersion();
            const resolvedPinnedVersion = pinnedVersion || active?.version || null;
            const updateRequired = Boolean(minVersion && (
              (resolvedPinnedVersion && compare(resolvedPinnedVersion, minVersion) < 0) ||
              (active?.version && compare(active.version, minVersion) < 0)
            ));

            reply(MESSAGE_TYPES.VERSION_INFO, {
              activeVersion: active?.version || null,
              stagedVersion: staged?.complete ? staged.version : null,
              swVersion: config.version,
              pinnedCache: pinnedCache || active?.cache || null,
              pinnedVersion: resolvedPinnedVersion,
              minVersion: minVersion || null,
              updateRequired,
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
            reply(MESSAGE_TYPES.STATUS_INFO, {
              status,
              commitDeferred: isCommitDeferred(),
            });
          } catch (err) {
            reply(MESSAGE_TYPES.STATUS_INFO, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.GET_SHARED_DATA:
        event.waitUntil((async () => {
          try {
            const data = await getLatestSharedData();
            reply(MESSAGE_TYPES.SHARED_DATA, data);
          } catch (err) {
            reply(MESSAGE_TYPES.SHARED_DATA, null, err);
          }
        })());
        break;

      case MESSAGE_TYPES.SET_BADGE:
        event.waitUntil((async () => {
          try {
            const count = event.data?.count;
            let success = false;
            if (typeof navigator !== 'undefined') {
              if (count === 0 && typeof navigator.clearAppBadge === 'function') {
                await navigator.clearAppBadge();
                success = true;
              } else if (typeof navigator.setAppBadge === 'function') {
                if (count === undefined || count === null) {
                  await navigator.setAppBadge();
                } else {
                  await navigator.setAppBadge(Math.max(0, Math.floor(Number(count))));
                }
                success = true;
              }
            }
            reply(MESSAGE_TYPES.BADGE_RESULT, { success, count });
          } catch (err) {
            reply(MESSAGE_TYPES.BADGE_RESULT, { success: false }, err);
          }
        })());
        break;

      case MESSAGE_TYPES.CLEAR_BADGE:
        event.waitUntil((async () => {
          try {
            let success = false;
            if (typeof navigator !== 'undefined' && typeof navigator.clearAppBadge === 'function') {
              await navigator.clearAppBadge();
              success = true;
            }
            reply(MESSAGE_TYPES.BADGE_RESULT, { success, count: 0 });
          } catch (err) {
            reply(MESSAGE_TYPES.BADGE_RESULT, { success: false }, err);
          }
        })());
        break;
    }
  };
}
