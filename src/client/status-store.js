import { onInstallable, isInstalled, isInstallable, promptInstall } from './install.js';
import { isStoragePersistent, requestPersistentStorage } from './storage.js';
import {
  onUpdateReady,
  onNoUpdate,
  onUpdateFailed,
  onStagingProgress,
  applyUpdate,
} from './update-ui.js';
import {
  onUpdateApplied,
  onUpdateRequired,
} from './registration.js';
import {
  getVersion,
  getStatus,
  requestUpdateCheck,
} from './messaging.js';

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
        patch.updateStatus = stat.commitDeferred ? 'commit-deferred' : (stat.status || 'idle');
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
 * Unified NLPWA client singleton interface.
 */
export const nlpwa = {
  getState,
  subscribe,
  install: promptInstall,
  promptInstall,
  isInstallable,
  isInstalled,
  checkUpdate: requestUpdateCheck,
  applyUpdate,
  requestPersistentStorage: async () => {
    const granted = await requestPersistentStorage();
    setState({ isStoragePersistent: granted });
    return granted;
  },
  isStoragePersistent,
};

export const client = nlpwa;
