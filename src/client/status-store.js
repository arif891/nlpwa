import { onInstallable, isInstalled, isInstallable, promptInstall, onAppInstalled } from './install.js';
import { isStoragePersistent, requestPersistentStorage } from './storage.js';
import { isBadgingSupported, setAppBadge, clearAppBadge } from './badge.js';
import { getSharedData, onShareTarget } from './share-target.js';
import {
  onUpdateReady,
  onNoUpdate,
  onUpdateFailed,
  onStagingProgress,
  applyUpdate,
} from './update-ui.js';
import {
  register,
  unregister,
  isUserEditing,
  onUpdateApplied,
  onUpdateRequired,
} from './registration.js';
import {
  getVersion,
  getStatus,
  requestUpdateCheck,
  sendToSW,
  requestFromSW,
} from './messaging.js';
import { getCacheInfo, cleanupRuntimeCache } from './cache-manager.js';
import { getDiagnostics, getPinStatus } from './diagnostics.js';
import {
  registerDirtyGuard,
  setDirty,
  isTabDirty,
  checkDirtyTabs,
  isLeader,
  onLeaderChange,
} from './tabs.js';
import {
  markHealthy,
  reportBootFailure,
  rollback,
  getBlockedVersions,
  onRollbackApplied,
  watchdog,
} from './watchdog.js';

/**
 * @typedef {Object} NLPWAState
 * @property {boolean} online
 * @property {'idle' | 'checking' | 'staging' | 'ready' | 'applying' | 'commit-deferred' | 'failed'} updateStatus
 * @property {string | null} version
 * @property {string | null} activeVersion
 * @property {string | null} stagedVersion
 * @property {string | null} minVersion
 * @property {boolean} updateRequired
 * @property {boolean} isInstallable
 * @property {boolean} isInstalled
 * @property {boolean | null} isStoragePersistent
 * @property {number | null} badgeCount
 * @property {string | null} channel
 * @property {{ loaded: number, total: number, percent: number, file?: string } | null} stagingProgress
 */

/** @type {NLPWAState} */
let _state = {
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  updateStatus: 'idle',
  version: null,
  activeVersion: null,
  stagedVersion: null,
  minVersion: null,
  updateRequired: false,
  isInstallable: isInstallable(),
  isInstalled: isInstalled(),
  isStoragePersistent: null,
  badgeCount: null,
  channel: typeof localStorage !== 'undefined' ? (localStorage.getItem('nlpwa_channel') || null) : null,
  stagingProgress: null,
};

const _subscribers = new Set();

function setState(patch) {
  _state = { ..._state, ...patch };
  notifySubscribers();
}

function notifySubscribers() {
  const current = getState();
  for (const listener of _subscribers) {
    try {
      listener(current);
    } catch {}
  }
}

/**
 * Get a synchronous snapshot of the current NLPWA state.
 *
 * @returns {NLPWAState}
 */
export function getState() {
  return { ..._state };
}

/**
 * Subscribe to NLPWA state changes.
 * The listener is called immediately with the current state upon subscription.
 *
 * @param {(state: NLPWAState) => void} listener
 * @returns {() => void} Unsubscribe function
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _subscribers.add(listener);

  try {
    listener(getState());
  } catch {}

  return () => {
    _subscribers.delete(listener);
  };
}

// ── Initialize Event Listeners ───────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setState({ online: true });
  });

  window.addEventListener('offline', () => {
    setState({ online: false });
  });

  // Track install state
  onInstallable((info) => {
    setState({
      isInstallable: info.isInstallable,
      isInstalled: info.isInstalled,
    });
  });

  // Check storage persistence
  isStoragePersistent().then((persisted) => {
    setState({ isStoragePersistent: persisted });
  }).catch(() => {});

  // SW Update events
  onUpdateReady((data) => {
    setState({
      updateStatus: 'ready',
      stagedVersion: data?.version || null,
      stagingProgress: null,
    });
  });

  onNoUpdate((data) => {
    setState({
      updateStatus: 'idle',
      stagingProgress: null,
    });
  });

  onUpdateFailed((data) => {
    setState({
      updateStatus: 'failed',
      stagingProgress: null,
    });
  });

  onStagingProgress((data) => {
    setState({
      updateStatus: 'staging',
      stagingProgress: data ? {
        loaded: data.loaded,
        total: data.total,
        percent: data.percent,
        file: data.file,
      } : null,
    });
  });

  onUpdateApplied((data) => {
    const newVersion = data?.version || _state.stagedVersion || _state.version;
    setState({
      updateStatus: 'idle',
      version: newVersion,
      activeVersion: newVersion,
      stagedVersion: null,
      stagingProgress: null,
    });
  });

  onUpdateRequired((data) => {
    setState({
      updateRequired: true,
      minVersion: data?.minVersion || null,
    });
  });

  // Initial SW query when controller becomes available
  const querySW = async () => {
    try {
      const [ver, stat] = await Promise.all([
        getVersion().catch(() => null),
        getStatus().catch(() => null),
      ]);
      const patch = {};
      if (ver) {
        patch.version = ver.activeVersion || null;
        patch.activeVersion = ver.activeVersion || null;
        patch.stagedVersion = ver.stagedVersion || null;
        patch.minVersion = ver.minVersion || null;
        patch.updateRequired = Boolean(ver.updateRequired);
      }
      if (stat) {
        patch.updateStatus = typeof stat === 'string'
          ? stat
          : (stat.commitDeferred ? 'commit-deferred' : (stat.status || 'idle'));
      }
      if (Object.keys(patch).length > 0) {
        setState(patch);
      }
    } catch {}
  };

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    if (navigator.serviceWorker.controller) {
      querySW();
    } else {
      navigator.serviceWorker.addEventListener?.('controllerchange', querySW, { once: true });
    }
  }
}

/**
 * Subscribe to a release channel (e.g. 'beta', 'canary', 'stable').
 *
 * @param {string} channel
 * @returns {Promise<string>}
 */
export async function subscribeChannel(channel) {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('nlpwa_channel', channel);
    } catch {}
  }
  setState({ channel });
  try {
    const { sendToSW } = await import('./messaging.js');
    await sendToSW({ type: 'SET_CHANNEL', channel });
  } catch {}
  return channel;
}

export const setChannel = subscribeChannel;

/**
 * Get currently subscribed release channel.
 *
 * @returns {string | null}
 */
export function getChannel() {
  if (_state.channel) return _state.channel;
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem('nlpwa_channel') || null;
    } catch {}
  }
  return null;
}

/**
 * Unified NLPWA client singleton interface.
 */
export const nlpwa = {
  // Registration & Service Worker
  register,
  unregister,
  isUserEditing,

  // Reactive State Store
  getState,
  subscribe,
  subscribeChannel,
  setChannel,
  getChannel,

  // Installation
  install: promptInstall,
  promptInstall,
  isInstallable,
  canInstall: isInstallable,
  isInstalled,
  onInstallable,
  onInstallPrompt: onInstallable,
  onAppInstalled,
  onInstalled: onAppInstalled,

  // Update Lifecycle & UI
  checkUpdate: requestUpdateCheck,
  requestUpdateCheck,
  applyUpdate,
  onUpdateReady,
  onNoUpdate,
  onUpdateRequired,
  onUpdateFailed,
  onUpdateApplied,
  onStagingProgress,

  // Messaging & SW Queries
  sendToSW,
  requestFromSW,
  getVersion,
  getStatus,

  // Cache & Storage
  getCacheInfo,
  getStorageEstimate: getCacheInfo,
  cleanupRuntimeCache,
  cleanRuntimeCache: cleanupRuntimeCache,
  requestPersistentStorage: async () => {
    const granted = await requestPersistentStorage();
    setState({ isStoragePersistent: granted });
    return granted;
  },
  isStoragePersistent,

  // App Badging
  setBadge: async (count) => {
    const ok = await setAppBadge(count);
    if (ok) {
      setState({ badgeCount: count === undefined || count === null ? 1 : Math.max(0, Math.floor(Number(count))) });
    }
    return ok;
  },
  clearBadge: async () => {
    const ok = await clearAppBadge();
    if (ok) {
      setState({ badgeCount: 0 });
    }
    return ok;
  },
  isBadgingSupported,
  isBadgeSupported: isBadgingSupported,

  // Share Target
  getSharedData,
  onShareTarget,

  // Diagnostics & Pinning
  diagnostics: getDiagnostics,
  getDiagnostics,
  getPinStatus,

  // Multi-Tab Consensus
  registerDirtyGuard,
  setDirty,
  isTabDirty,
  checkDirtyTabs,
  isLeader,
  onLeaderChange,

  // Watchdog & Health Rollback
  markHealthy,
  reportBootFailure,
  rollback,
  getBlockedVersions,
  onRollbackApplied,
  watchdog,
};

export const client = nlpwa;
