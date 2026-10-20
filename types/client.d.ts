export interface UpdateReadyData {
  version: string;
}

export interface NoUpdateData {
  version: string;
}

export interface UpdateAppliedData {
  version?: string;
}

export interface UpdatePromptData {
  version?: string;
  updateApplied?: boolean;
  reason?: 'editing' | 'deferred' | string;
}

export interface UpdateRequiredData {
  minVersion: string;
  activeVersion?: string | null;
  targetVersion?: string | null;
  unpinnedClients?: string[];
}

export interface StagingProgressData {
  version: string;
  loaded: number;
  total: number;
  percent: number;
  file?: string;
}

export interface VersionInfoData {
  activeVersion: string | null;
  stagedVersion: string | null;
  swVersion: string | null;
  pinnedCache?: string | null;
  pinnedVersion?: string | null;
  minVersion?: string | null;
  updateRequired?: boolean;
}

export interface UpdateFailedData {
  version?: string;
  errorCode?: 'HASH_MISMATCH' | 'QUOTA_EXCEEDED' | 'DOWNLOAD_FAILED' | string;
  failed?: string[];
  failedDetails?: Record<string, string>;
  error?: string;
  retryCount?: number;
  nextRetryAt?: number | null;
  persistent?: boolean;
  hasHashMismatch?: boolean;
  quotaExceeded?: boolean;
}

export interface CacheInfoData {
  quota: number | null;
  usage: number | null;
  percentUsed: number | null;
  remaining: number | null;
  runtimeEntries: number;
  runtimeBytes: number;
  largestEntries: Array<{ url: string; size: number; cachedAt: number }>;
}

export interface CleanupRuntimeOptions {
  strategy?: 'largest' | 'lru' | 'max-age' | 'quota' | 'pattern' | 'all';
  maxItem?: string | number;
  maxItemBytes?: number;
  maxItemKB?: number;
  maxItemMB?: number;
  minItem?: string | number;
  minItemBytes?: number;
  minItemKB?: number;
  minItemMB?: number;
  maxTotal?: string | number;
  maxTotalBytes?: number;
  maxTotalKB?: number;
  maxTotalMB?: number;
  maxEntries?: number;
  maxAgeMs?: number;
  maxQuota?: string | number;
  maxQuotaPercent?: number;
  maxQuotaBytes?: number;
  maxQuotaMB?: number;
  preferLargest?: boolean;
  match?: string;
  pattern?: string;
  count?: number;
}

export interface CleanupRuntimeResult {
  success: boolean;
  strategy: string;
  evictedCount: number;
  evictedUrls: string[];
  freedBytes: number;
  remainingEntries: number;
  remainingBytes: number;
  quota: CacheInfoData;
}

export interface RegisterOptions {
  /** Worker type ('classic' | 'module') */
  type?: 'classic' | 'module';
  /** Service Worker scope */
  scope?: string;
  /** ServiceWorkerRegistration updateViaCache option */
  updateViaCache?: 'all' | 'none' | 'imports';
  /** Called when the SW signals that an update is ready */
  onUpdateReady?: (data: UpdateReadyData) => void;
  /** Called when the SW signals that the app is already up to date */
  onNoUpdate?: (data: NoUpdateData) => void;
  /** Called when the active or pinned version is below minimum supported version required by the server */
  onUpdateRequired?: (data: UpdateRequiredData) => void;
  /** Called when an update fails to stage or verify */
  onUpdateFailed?: (data: UpdateFailedData) => void;
  /** Called when an update is committed/applied (in this tab or another tab) */
  onUpdateApplied?: (data: UpdateAppliedData) => void;
  /** Called when auto-reload is deferred because user is editing form inputs or shouldDeferReload returned true */
  onUpdatePrompt?: (data: UpdatePromptData) => void;
  /** Predicate to defer auto-reload (e.g. for unsaved in-memory state or active video calls) */
  shouldDeferReload?: (context: { version?: string; reason: string }) => boolean;
  /** Automatically apply update and reload on update (default: false) */
  autoReload?: boolean;
  /** Automatically reload when another tab applies an update (default: false) */
  reloadOnUpdateApplied?: boolean;
  /** Check for update when tab regains focus (default: true) */
  checkOnFocus?: boolean;
  /** Check for update on initial registration via non-blocking message (default: true) */
  checkOnRegister?: boolean;
  /** Min ms between focus-triggered checks (default: 1 hour) */
  focusThrottleMs?: number;
  /** Client-side poll interval in ms (default: 1 hour) */
  pollIntervalMs?: number;
  /** Enable Periodic Background Sync if supported (default: true) */
  periodicSync?: boolean;
  /** Request persistent storage via navigator.storage.persist() (default: false) */
  persistentStorage?: boolean;
}

export interface RegistrationHandle {
  registration: ServiceWorkerRegistration;
  unsubscribe: () => void;
}

/**
 * Register the NLPWA Service Worker and set up update handling.
 *
 * @param swUrl Path to the bundled sw.js (default: '/sw.js')
 * @param options Registration and update options
 */
export function register(swUrl?: string, options?: RegisterOptions): Promise<RegistrationHandle | null>;

/**
 * Unregister the NLPWA Service Worker.
 *
 * @param scope Optional scope of registration to unregister
 */
export function unregister(scope?: string): Promise<boolean>;

/**
 * Register a handler to be called when the SW signals an update is ready.
 *
 * @param callback Callback receiving version
 * @returns Unsubscribe function
 */
export function onUpdateReady(callback?: (data: UpdateReadyData) => void): () => void;

/**
 * Register a handler to be called when the SW signals that the app is already up to date.
 *
 * @param callback Callback receiving current version
 * @returns Unsubscribe function
 */
export function onNoUpdate(callback?: (data: NoUpdateData) => void): () => void;

/**
 * Register a handler to be called when the server requires an immediate update due to minVersion.
 *
 * @param callback Callback receiving minVersion requirement details
 * @returns Unsubscribe function
 */
export function onUpdateRequired(callback?: (data: UpdateRequiredData) => void): () => void;

/**
 * Register a handler to be called when the SW signals that an update failed to stage or verify.
 *
 * @param callback Callback receiving error and failure details
 * @returns Unsubscribe function
 */
export function onUpdateFailed(callback?: (data: UpdateFailedData) => void): () => void;

/**
 * Register a handler to be called when an update is committed/applied (in this tab or another tab).
 *
 * @param callback Callback receiving applied version
 * @returns Unsubscribe function
 */
export function onUpdateApplied(callback?: (data: UpdateAppliedData) => void): () => void;

/**
 * Register a handler to be called when update staging download progress occurs.
 *
 * @param callback Callback receiving progress info (loaded, total, percent, file)
 * @returns Unsubscribe function
 */
export function onStagingProgress(callback?: (data: StagingProgressData) => void): () => void;

/**
 * Switch to the staged update, then reload the page (or commit without reloading in SPAs).
 *
 * @param options Options including timeout and whether to reload (default: true)
 */
export function applyUpdate(options?: { timeoutMs?: number; reload?: boolean }): Promise<boolean>;

/**
 * Trigger a manual update check from the client side.
 */
export function requestUpdateCheck(): Promise<void>;

/**
 * Send a typed message to the active Service Worker.
 */
export function sendToSW(message: Record<string, unknown>): Promise<void>;

/**
 * Send a request message to the active Service Worker and await a response.
 */
export function requestFromSW<T = any>(
  type: string,
  payload?: Record<string, unknown>,
  replyType?: string,
  timeoutMs?: number
): Promise<T>;

/**
 * Query active and staged versions from the Service Worker.
 */
export function getVersion(timeoutMs?: number): Promise<VersionInfoData>;

/**
 * Query current update lifecycle status from the Service Worker.
 */
export function getStatus(timeoutMs?: number): Promise<'idle' | 'checking' | 'staging' | 'ready' | 'applying'>;

/**
 * Request storage quota and runtime cache usage metrics from the Service Worker.
 */
export function getCacheInfo(options?: { timeoutMs?: number }): Promise<CacheInfoData>;

/**
 * Request cleanup on the runtime cache using one or more strategies.
 */
export function cleanupRuntimeCache(
  cleanupOptions?: CleanupRuntimeOptions,
  options?: { timeoutMs?: number }
): Promise<CleanupRuntimeResult>;

/**
 * Check if the user is currently editing an active input, textarea, select, or contenteditable element.
 *
 * @returns true if an interactive editing element currently has focus
 */
export function isUserEditing(): boolean;

export interface InstallInfo {
  isInstallable: boolean;
  isInstalled: boolean;
  prompt: () => Promise<{ outcome: 'accepted' | 'dismissed', platform: string }>;
}

/**
 * Check if the application is currently running in standalone / installed mode.
 */
export function isInstalled(): boolean;

/**
 * Check if the application can currently be installed via a prompt.
 */
export function isInstallable(): boolean;

/**
 * Register a listener for when the app becomes installable or installation state changes.
 */
export function onInstallable(callback: (info: InstallInfo) => void): () => void;

/**
 * Register a listener for when the app is successfully installed.
 */
export function onAppInstalled(callback: (event: Event) => void): () => void;

/**
 * Trigger the native PWA install prompt if available.
 */
export function promptInstall(): Promise<{ outcome: 'accepted' | 'dismissed', platform: string }>;

/**
 * Check whether storage persistence is already granted by the browser.
 */
export function isStoragePersistent(): Promise<boolean>;

/**
 * Request persistent storage from the browser.
 */
export function requestPersistentStorage(): Promise<boolean>;

/**
 * Check if the Badging API is supported by the current browser environment.
 */
export function isBadgingSupported(): boolean;

/**
 * Set the application badge count.
 * @param count Badge count (positive integer) or undefined for an uncounted dot badge.
 */
export function setAppBadge(count?: number | null): Promise<boolean>;

/**
 * Clear the application badge.
 */
export function clearAppBadge(): Promise<boolean>;

export interface SharedTargetFile {
  name: string;
  type: string;
  size: number;
  lastModified?: number;
  url?: string;
  blob?: Blob;
  error?: string;
}

export interface SharedTargetData {
  id?: string;
  title?: string;
  text?: string;
  url?: string;
  files?: SharedTargetFile[];
  timestamp?: number;
}

/**
 * Retrieve any pending shared data received by the Service Worker via Web Share Target.
 */
export function getSharedData(): Promise<SharedTargetData | null>;

/**
 * Subscribe to Web Share Target events when files or text are shared to the app.
 */
export function onShareTarget(callback: (sharedData: SharedTargetData) => void): () => void;

export interface NLPWAState {
  online: boolean;
  updateStatus: 'idle' | 'checking' | 'staging' | 'ready' | 'applying' | 'commit-deferred' | 'failed';
  version: string | null;
  activeVersion: string | null;
  stagedVersion: string | null;
  minVersion: string | null;
  updateRequired: boolean;
  isInstallable: boolean;
  isInstalled: boolean;
  isStoragePersistent: boolean | null;
  badgeCount: number | null;
  stagingProgress: { loaded: number; total: number; percent: number; file?: string } | null;
}

/**
 * Get a synchronous snapshot of the current NLPWA state.
 */
export function getState(): NLPWAState;

/**
 * Subscribe to NLPWA state changes.
 */
export function subscribe(listener: (state: NLPWAState) => void): () => void;

export interface NLPWAClientAPI {
  register: typeof register;
  unregister: typeof unregister;
  onUpdateReady: typeof onUpdateReady;
  onNoUpdate: typeof onNoUpdate;
  onUpdateRequired: typeof onUpdateRequired;
  onUpdateFailed: typeof onUpdateFailed;
  onUpdateApplied: typeof onUpdateApplied;
  onStagingProgress: typeof onStagingProgress;
  applyUpdate: typeof applyUpdate;
  requestUpdateCheck: typeof requestUpdateCheck;
  sendToSW: typeof sendToSW;
  requestFromSW: typeof requestFromSW;
  getVersion: typeof getVersion;
  getStatus: typeof getStatus;
  getCacheInfo: typeof getCacheInfo;
  cleanupRuntimeCache: typeof cleanupRuntimeCache;
  isUserEditing: typeof isUserEditing;
  isInstalled: typeof isInstalled;
  isInstallable: typeof isInstallable;
  onInstallable: typeof onInstallable;
  onAppInstalled: typeof onAppInstalled;
  promptInstall: typeof promptInstall;
  isStoragePersistent: typeof isStoragePersistent;
  requestPersistentStorage: typeof requestPersistentStorage;
  setBadge: (count?: number | null) => Promise<boolean>;
  clearBadge: () => Promise<boolean>;
  isBadgingSupported: typeof isBadgingSupported;
  getSharedData: typeof getSharedData;
  onShareTarget: typeof onShareTarget;
  getState: typeof getState;
  subscribe: typeof subscribe;
}

export declare const nlpwa: NLPWAClientAPI;
export declare const client: NLPWAClientAPI;
export default client;
