export interface UpdateReadyData {
  version: string;
  partial: boolean;
}

export interface NoUpdateData {
  version: string;
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
  /** Automatically apply update and reload on update (default: false) */
  autoReload?: boolean;
  /** Check for update when tab regains focus (default: true) */
  checkOnFocus?: boolean;
  /** Min ms between focus-triggered checks (default: 1 hour) */
  focusThrottleMs?: number;
  /** Client-side poll interval in ms (default: 1 hour) */
  pollIntervalMs?: number;
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
 * Register a handler to be called when the SW signals an update is ready.
 *
 * @param callback Callback receiving version and partial flag
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
 * Switch to the staged update, then reload the page.
 *
 * @param options Options including timeout before fallback reload
 */
export function applyUpdate(options?: { timeoutMs?: number }): Promise<void>;

/**
 * Trigger a manual update check from the client side.
 */
export function requestUpdateCheck(): Promise<void>;

/**
 * Send a typed message to the active Service Worker.
 */
export function sendToSW(message: Record<string, unknown>): Promise<void>;

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

export interface NLPWAClientAPI {
  register: typeof register;
  onUpdateReady: typeof onUpdateReady;
  onNoUpdate: typeof onNoUpdate;
  applyUpdate: typeof applyUpdate;
  requestUpdateCheck: typeof requestUpdateCheck;
  sendToSW: typeof sendToSW;
  getCacheInfo: typeof getCacheInfo;
  cleanupRuntimeCache: typeof cleanupRuntimeCache;
}

declare const client: NLPWAClientAPI;
export default client;
