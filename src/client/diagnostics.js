import { MESSAGE_TYPES } from '../shared/constants.js';
import { requestFromSW } from './messaging.js';
import { isLeader, checkDirtyTabs, isTabDirty } from './tabs.js';
import { logger } from './logger.js';

/**
 * Request formalized pin status of the current client tab from the Service Worker.
 *
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<{
 *   clientId: string|null,
 *   state: 'BOOTING' | 'PINNED' | 'ORPHANED' | 'EXPIRED',
 *   version: string|null,
 *   cache: string|null,
 *   pinnedAt: number|null,
 *   lastSeenAt: number|null,
 *   graceRemainingMs: number|null
 * }|null>}
 */
export async function getPinStatus(timeoutMs = 2000) {
  try {
    return await requestFromSW(
      MESSAGE_TYPES.GET_PIN_STATUS,
      {},
      MESSAGE_TYPES.PIN_STATUS_INFO,
      timeoutMs
    );
  } catch (err) {
    logger.debug('[NLPWA] getPinStatus request failed:', err?.message || err);
    return null;
  }
}

/**
 * Retrieve comprehensive runtime diagnostics from the SW and client tab consensus bus.
 *
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{
 *   active: Object|null,
 *   staged: Object|null,
 *   pinStatus: Object|null,
 *   blockedVersions: string[],
 *   storage: Object|null,
 *   rollbackHistory: Array<Object>,
 *   updateStatus: string,
 *   client: {
 *     isLeader: boolean,
 *     isTabDirty: boolean,
 *     tabConsensus: { hasDirtyTabs: boolean, dirtyTabs: Array<Object> }
 *   }
 * }>}
 */
export async function getDiagnostics(timeoutMs = 3000) {
  let swDiag = null;
  try {
    swDiag = await requestFromSW(
      MESSAGE_TYPES.GET_DIAGNOSTICS,
      {},
      MESSAGE_TYPES.DIAGNOSTICS_INFO,
      timeoutMs
    );
  } catch (err) {
    logger.debug('[NLPWA] getDiagnostics SW request failed:', err?.message || err);
    swDiag = {
      active: null,
      staged: null,
      pinStatus: null,
      blockedVersions: [],
      storage: null,
      rollbackHistory: [],
      updateStatus: 'unknown',
      error: err?.message || String(err),
    };
  }

  let dirtyCheck = { hasDirtyTabs: false, dirtyTabs: [] };
  try {
    dirtyCheck = await checkDirtyTabs(80);
  } catch (err) {
    logger.debug('[NLPWA] checkDirtyTabs failed during diagnostics:', err);
  }

  return {
    ...swDiag,
    client: {
      isLeader: isLeader(),
      isTabDirty: isTabDirty(),
      tabConsensus: dirtyCheck,
    },
  };
}
