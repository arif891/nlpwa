export interface UpdateReadyData {
  version: string;
  partial: boolean;
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
  /** Automatically apply update and reload on update (default: false) */
  autoReload?: boolean;
  /** Check for update when tab regains focus (default: true) */
  checkOnFocus?: boolean;
  /** Min ms between focus-triggered checks (default: 5 min) */
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

export interface NLPWAClientAPI {
  register: typeof register;
  onUpdateReady: typeof onUpdateReady;
  applyUpdate: typeof applyUpdate;
  requestUpdateCheck: typeof requestUpdateCheck;
  sendToSW: typeof sendToSW;
}

declare const client: NLPWAClientAPI;
export default client;
