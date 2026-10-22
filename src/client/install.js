/**
 * Client-side PWA installation manager.
 * Intercepts beforeinstallprompt, exposes promptInstall(), and emits installability state.
 */

let _deferredPrompt = null;
let _isInstalled = false;
const _listeners = new Set();
const _installedListeners = new Set();

function checkInstalled() {
  if (typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? navigator : window?.navigator;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)')?.matches ||
    nav?.standalone === true
  );
}

_isInstalled = checkInstalled();

if (typeof window !== 'undefined') {
  // Listen for beforeinstallprompt
  window.addEventListener('beforeinstallprompt', (event) => {
    // Prevent the mini-infobar from appearing on mobile
    event.preventDefault();
    _deferredPrompt = event;
    _isInstalled = false;
    notifyListeners();
  });

  // Listen for appinstalled
  window.addEventListener('appinstalled', (event) => {
    _deferredPrompt = null;
    _isInstalled = true;
    notifyListeners();
    for (const listener of _installedListeners) {
      try {
        listener(event);
      } catch {}
    }
  });

  // Track display mode changes (e.g. if opened in standalone)
  try {
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener?.('change', (e) => {
      _isInstalled = e.matches;
      notifyListeners();
    });
  } catch {}
}

function notifyListeners() {
  const info = getInstallInfo();
  for (const listener of _listeners) {
    try {
      listener(info);
    } catch {}
  }
}

/**
 * Get current installability state.
 *
 * @returns {{ isInstallable: boolean, isInstalled: boolean }}
 */
export function getInstallInfo() {
  return {
    isInstallable: Boolean(_deferredPrompt),
    isInstalled: _isInstalled || checkInstalled(),
  };
}

/**
 * Check if the application is currently running in standalone / installed mode.
 *
 * @returns {boolean}
 */
export function isInstalled() {
  return _isInstalled || checkInstalled();
}

/**
 * Check if the application can currently be installed via a prompt.
 *
 * @returns {boolean}
 */
export function isInstallable() {
  return Boolean(_deferredPrompt);
}

/**
 * Register a listener for when the app becomes installable or installation state changes.
 * Invoked immediately with current state upon subscription.
 *
 * @param {(info: { isInstallable: boolean, isInstalled: boolean, prompt: () => Promise<{ outcome: string, platform: string }> }) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onInstallable(callback) {
  if (typeof callback !== 'function') return () => {};
  _listeners.add(callback);

  // Invoke immediately with current state
  try {
    callback({
      ...getInstallInfo(),
      prompt: promptInstall,
    });
  } catch {}

  return () => {
    _listeners.delete(callback);
  };
}

/**
 * Register a listener for when the app is successfully installed.
 *
 * @param {(event: Event) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onAppInstalled(callback) {
  if (typeof callback !== 'function') return () => {};
  _installedListeners.add(callback);
  return () => {
    _installedListeners.delete(callback);
  };
}

/**
 * Trigger the native PWA install prompt if available.
 *
 * @returns {Promise<{ outcome: 'accepted' | 'dismissed', platform: string }>}
 */
export async function promptInstall() {
  if (!_deferredPrompt) {
    return { outcome: 'dismissed', platform: '' };
  }

  const promptEvent = _deferredPrompt;
  _deferredPrompt = null;
  notifyListeners();

  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') {
      _isInstalled = true;
      notifyListeners();
    }
    return {
      outcome: choice?.outcome ?? 'dismissed',
      platform: choice?.platform ?? '',
    };
  } catch (err) {
    return { outcome: 'dismissed', platform: '' };
  }
}

// Ergonomic aliases matching documentation
export const canInstall = isInstallable;
export const onInstallPrompt = onInstallable;
export const onInstalled = onAppInstalled;
