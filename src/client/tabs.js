import { isUserEditing } from './form-guard.js';
import { logger } from './logger.js';

export const TAB_BUS_NAME = 'nlpwa-tab-bus';

const tabId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Date.now().toString(36);

const dirtyGuards = new Set();
let manualDirty = false;

let bus = null;
let _isLeader = false;
const leaderListeners = new Set();

function getBus() {
  if (bus) return bus;
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    try {
      bus = new BroadcastChannel(TAB_BUS_NAME);
      bus.addEventListener('message', handleBusMessage);
    } catch (err) {
      logger.debug('[NLPWA] BroadcastChannel unavailable:', err?.message || err);
    }
  }
  return bus;
}

/**
 * Handle incoming tab bus broadcast messages.
 *
 * @param {MessageEvent} event
 */
function handleBusMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'TAB_QUERY_DIRTY' && data.fromTabId !== tabId) {
    const isDirty = isTabDirty();
    const title = typeof document !== 'undefined' ? document.title : '';
    const channel = getBus();
    if (channel) {
      channel.postMessage({
        type: 'TAB_DIRTY_STATUS',
        queryId: data.queryId,
        tabId,
        isDirty,
        title,
      });
    }
  }
}

/**
 * Register a custom dirty guard function.
 * Called whenever update consensus queries the tab for unsaved state.
 *
 * @param {() => boolean} guardFn
 * @returns {() => void} unsubscribe function
 */
export function registerDirtyGuard(guardFn) {
  getBus();
  if (typeof guardFn === 'function') {
    dirtyGuards.add(guardFn);
  }
  return () => {
    dirtyGuards.delete(guardFn);
  };
}

/**
 * Programmatically mark this tab as having unsaved dirty changes.
 *
 * @param {boolean} dirty
 */
export function setDirty(dirty) {
  getBus();
  manualDirty = Boolean(dirty);
}

/**
 * Check whether THIS local tab has unsaved form data or active editing.
 *
 * @returns {boolean}
 */
export function isTabDirty() {
  if (manualDirty) return true;
  for (const guard of dirtyGuards) {
    try {
      if (guard() === true) return true;
    } catch (err) {
      logger.debug('[NLPWA] Dirty guard error:', err?.message || err);
    }
  }
  return isUserEditing();
}

/**
 * Query all open tabs across the tab consensus bus for unsaved changes.
 *
 * @param {number} [timeoutMs=150]
 * @returns {Promise<{ hasDirtyTabs: boolean, dirtyTabs: Array<{ tabId: string, title: string, local?: boolean }> }>}
 */
export async function checkDirtyTabs(timeoutMs = 150) {
  const dirtyTabs = [];

  // Check local tab first
  if (isTabDirty()) {
    dirtyTabs.push({
      tabId,
      title: typeof document !== 'undefined' ? document.title : 'Current Tab',
      local: true,
    });
  }

  const channel = getBus();
  if (!channel) {
    return {
      canReload: dirtyTabs.length === 0,
      hasDirtyTabs: dirtyTabs.length > 0,
      dirtyTabs,
    };
  }

  const queryId = Math.random().toString(36).slice(2);

  await new Promise((resolve) => {
    let timer = null;

    const onMessage = (event) => {
      const data = event.data;
      if (data && data.type === 'TAB_DIRTY_STATUS' && data.queryId === queryId) {
        if (data.isDirty) {
          dirtyTabs.push({
            tabId: data.tabId,
            title: data.title || 'Background Tab',
            local: false,
          });
        }
      }
    };

    channel.addEventListener('message', onMessage);
    channel.postMessage({
      type: 'TAB_QUERY_DIRTY',
      queryId,
      fromTabId: tabId,
    });

    timer = setTimeout(() => {
      channel.removeEventListener('message', onMessage);
      resolve();
    }, timeoutMs);
  });

  return {
    canReload: dirtyTabs.length === 0,
    hasDirtyTabs: dirtyTabs.length > 0,
    dirtyTabs,
  };
}

/**
 * Whether this tab is currently the elected leader among all open tabs.
 *
 * @returns {boolean}
 */
export function isLeader() {
  return _isLeader;
}

/**
 * Subscribe to tab leader election changes.
 *
 * @param {(isLeader: boolean) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onLeaderChange(callback) {
  if (typeof callback === 'function') {
    leaderListeners.add(callback);
    callback(_isLeader);
  }
  return () => {
    leaderListeners.delete(callback);
  };
}

function notifyLeader(newLeaderState) {
  if (_isLeader !== newLeaderState) {
    _isLeader = newLeaderState;
    for (const listener of leaderListeners) {
      try {
        listener(_isLeader);
      } catch (err) {
        logger.debug('[NLPWA] Leader change listener error:', err);
      }
    }
  }
}

// ── Web Locks Leader Election ──────────────────────────────────────────────
let leaderLockPromise = null;
let releaseLeaderLock = null;

export function initTabElection() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    if (leaderLockPromise) return;
    leaderLockPromise = navigator.locks.request('nlpwa_tab_leader', () => {
      notifyLeader(true);
      return new Promise((resolve) => {
        releaseLeaderLock = resolve;
        window.addEventListener('pagehide', () => {
          notifyLeader(false);
          resolve();
        }, { once: true });
        window.addEventListener('beforeunload', () => {
          notifyLeader(false);
          resolve();
        }, { once: true });
      });
    }).catch(() => {
      notifyLeader(false);
    });
  } else {
    // Single tab / no web locks fallback: tab is leader by default
    notifyLeader(true);
  }
}

// Automatically start tab election and consensus bus in browser environments
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initTabElection();
  getBus();
}

/**
 * Close tab bus and reset state (used for testing or teardown).
 */
export function closeTabBus() {
  if (bus) {
    bus.removeEventListener('message', handleBusMessage);
    bus.close();
    bus = null;
  }
  dirtyGuards.clear();
  manualDirty = false;
  _isLeader = false;
  leaderListeners.clear();
  if (releaseLeaderLock) {
    releaseLeaderLock();
    releaseLeaderLock = null;
  }
  leaderLockPromise = null;
}

export { tabId };
