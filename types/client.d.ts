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
  maxItemBytes?: number;
  maxItemKB?: number;
  maxItemMB?: number;
  minItemBytes?: number;
  minItemKB?: number;
  minItemMB?: number;
  maxTotalBytes?: number;
  maxTotalKB?: number;
  maxTotalMB?: number;
  maxEntries?: number;
  maxAgeMs?: number;
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

export interface NLPWAClientAPI {
  register: typeof register;
  unregister: typeof unregister;
  onUpdateReady: typeof onUpdateReady;
  onNoUpdate: typeof onNoUpdate;
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
}

declare const client: NLPWAClientAPI;
export default client;
