export type FetchStrategy =
  | 'cache-first'
  | 'network-first'
  | 'network-only'
  | 'stale-while-revalidate'
  | 'cache-only';

export interface RequestWillFetchParams {
  request: Request;
  event?: any;
  options?: any;
}

export interface CachedResponseWillBeUsedParams {
  cacheName: string;
  request: Request;
  matchOptions?: CacheQueryOptions;
  cachedResponse: Response;
  event?: any;
  options?: any;
}

export interface CacheWillUpdateParams {
  request: Request;
  response: Response;
  event?: any;
  cacheName?: string;
  options?: any;
}

export interface FetchDidSucceedParams {
  request: Request;
  response: Response;
  event?: any;
  options?: any;
}

export interface FetchDidFailParams {
  error: Error;
  originalRequest: Request;
  request: Request;
  event?: any;
  options?: any;
}

export interface CacheDidUpdateParams {
  cacheName: string;
  request: Request;
  oldResponse?: Response;
  newResponse: Response;
  event?: any;
  options?: any;
}

export interface CacheKeyWillBeUsedParams {
  request: Request | string;
  mode: 'read' | 'write';
  event?: any;
  options?: any;
}

export interface NLPWAPlugin {
  /** Optional plugin name or identifier */
  name?: string;
  /** Called before a network request is made; can return a modified Request or synthetic Response */
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | Response | void> | Request | Response | void;
  /** Called before a cached response is used; returning null treats it as a cache miss */
  cachedResponseWillBeUsed?: (params: CachedResponseWillBeUsedParams) => Promise<Response | null | void> | Response | null | void;
  /** Called before writing to cache; returning null or false skips caching */
  cacheWillUpdate?: (params: CacheWillUpdateParams) => Promise<Response | null | boolean | void> | Response | null | boolean | void;
  /** Called after a network fetch succeeds */
  fetchDidSucceed?: (params: FetchDidSucceedParams) => Promise<Response | void> | Response | void;
  /** Called when a network fetch fails */
  fetchDidFail?: (params: FetchDidFailParams) => Promise<void> | void;
  /** Called after a cache entry has been updated */
  cacheDidUpdate?: (params: CacheDidUpdateParams) => Promise<void> | void;
  /** Called to customize or rewrite cache keys on read and write */
  cacheKeyWillBeUsed?: (params: CacheKeyWillBeUsedParams) => Promise<Request | string> | Request | string;
  /** Notification click lifecycle hook (e.g. BadgePlugin) */
  onNotificationClick?: (event: any) => Promise<void> | void;
  /** Push event lifecycle hook (e.g. BadgePlugin) */
  onPush?: (event: any, payload?: any) => Promise<void> | void;
  /** Background fetch lifecycle hooks (e.g. BackgroundFetchPlugin) */
  onBackgroundFetchSuccess?: (event: any, options?: any) => Promise<void> | void;
  onBackgroundFetchFail?: (event: any) => Promise<void> | void;
  onBackgroundFetchAbort?: (event: any) => Promise<void> | void;
  onBackgroundFetchClick?: (event: any, options?: any) => Promise<void> | void;
  /** Arbitrary properties and methods supported by plugin implementations */
  [key: string]: any;
}

export interface RouteConfig {
  /** URLPattern string, pattern object, or URLPattern instance to match request URL (e.g. '/api/:version/*', '/assets/*') */
  match?: string | URLPatternInit | any;
  /** Pre-compiled URLPattern instance or URLPatternInit object */
  pattern?: any;
  /** Extracted named route parameters (e.g. { id: '42' }) */
  params?: Record<string, string>;
  /** Caching and fetch strategy to use */
  strategy: FetchStrategy;
  /** Explicit origin to match (e.g. 'https://cdn.example.com' or '*') */
  origin?: string;
  /** Timeout in ms before network-first falls back to cache */
  networkTimeoutMs?: number;
  /** Fallback URL if request fails offline (for navigation) */
  navigationFallback?: string;
  /** Offline fallback page URL (alias/override for navigationFallback) */
  offlineFallback?: string;
  /** Ignore URL search query parameters when matching cache */
  ignoreSearch?: boolean;
  /** Whether failures should throw/reject instead of returning a synthetic 503 response */
  throwOnFailure?: boolean;
  /** Maximum age before runtime cache entry is considered stale (e.g. '7d', '24h', 3600000) */
  maxAge?: number | string;
  /** Whether to fall back to cached response when network returns a 5xx HTTP error */
  fallbackOn5xx?: boolean;
  /** Whether to cache opaque cross-origin responses (default: false to prevent ~7MB Chrome quota padding and caching 404s) */
  cacheOpaque?: boolean;
  /** Navigation URL patterns allowed to receive the SPA shell fallback (globs, RegExps, or predicates) */
  navigationAllowlist?: Array<string | RegExp | ((url: URL) => boolean)>;
  /** Navigation URL patterns excluded from receiving the SPA shell fallback */
  navigationDenylist?: Array<string | RegExp | ((url: URL) => boolean)>;
  /** Query parameters to ignore when matching and storing cache entries (e.g. [/^utm_/, /^fbclid$/]) */
  ignoreURLParametersMatching?: Array<string | RegExp>;
  /** Directory index filename when path ends with / (default: 'index.html') */
  directoryIndex?: string;
  /** Whether to match extensionless clean URLs against .html files (default: true) */
  cleanURLs?: boolean;
  /** Route-specific plugin hooks */
  plugins?: NLPWAPlugin[];
  /** Direct requestWillFetch hook shortcut */
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | Response | void> | Request | Response | void;
  /** Direct cachedResponseWillBeUsed hook shortcut */
  cachedResponseWillBeUsed?: (params: CachedResponseWillBeUsedParams) => Promise<Response | null | void> | Response | null | void;
  /** Direct cacheWillUpdate hook shortcut */
  cacheWillUpdate?: (params: CacheWillUpdateParams) => Promise<Response | null | boolean | void> | Response | null | boolean | void;
  /** Direct fetchDidSucceed hook shortcut */
  fetchDidSucceed?: (params: FetchDidSucceedParams) => Promise<Response | void> | Response | void;
  /** Direct fetchDidFail hook shortcut */
  fetchDidFail?: (params: FetchDidFailParams) => Promise<void> | void;
  /** Direct cacheDidUpdate hook shortcut */
  cacheDidUpdate?: (params: CacheDidUpdateParams) => Promise<void> | void;
  /** Direct cacheKeyWillBeUsed hook shortcut */
  cacheKeyWillBeUsed?: (params: CacheKeyWillBeUsedParams) => Promise<Request | string> | Request | string;
  /** Called after background stale-while-revalidate revalidation completes */
  onRevalidated?: (params: { request: Request; response: Response; cachedResponse: Response; event?: any }) => void;
}

export interface UpdateAPIConfigObject {
  /** Lightweight check returning { version: string } */
  version: string;
  /** Full manifest check returning { version: string, files: Array<{ path: string, hash: string }> } */
  info: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

export type UpdateAPIConfig = UpdateAPIConfigObject;

export interface NLPWAConfig {
  /** Service Worker / App version */
  version?: string;
  /** App version override when distinct from SW version */
  appVersion?: string;
  /**
   * Minimum required version (base semver, e.g. "2.0.0").
   * Tabs running an active or pinned version below this semver are unpinned and prompted to update immediately.
   * Note: Semver comparison evaluates base semver (major.minor.patch); digest/hash suffixes (e.g. 1.0.0-<hash>)
   * are non-monotonic content digests and are ignored for minVersion comparison.
   */
  minVersion?: string;
  /** Active release channel (e.g. 'stable', 'beta', 'canary') */
  channel?: string;
  /** Blacklisted/revoked versions that will be rejected or trigger emergency rollback if active */
  blockedVersions?: string[];
  /** Phased rollout percentage (0-100) for gradual Canary deployment */
  rolloutPercent?: number;
  /** Ed25519 public key (SPKI PEM, Base64, or Hex) for cryptographic manifest verification */
  publicKey?: string;
  /** Ed25519 private signing key (PKCS8 PEM or Base64) for CLI build signing */
  signingKey?: string;
  /** Custom Web Push notification event handler */
  onPush?: (event: any) => Promise<void> | void;
  /** Custom notification click event handler */
  onNotificationClick?: (event: any) => Promise<void> | void;
  /** Path to runtime config.json file (default: '/api/update/config.json') */
  configPath?: string;
  /** Two-tier update check endpoints */
  updateAPI?: UpdateAPIConfig;
  /** Timeout in milliseconds for update check requests (default: 15000) */
  updateTimeoutMs?: number;
  /** Staging progress event throttle in milliseconds (default: 250) */
  progressThrottleMs?: number;
  /** Maximum exponential backoff delay in milliseconds for failed staging retries (default: 3600000 = 1h) */
  maxBackoffMs?: number;
  /** Hash verification mode for update downloads */
  verifyHashes?: 'strict' | 'warn' | false;
  /** Maximum file size in bytes for in-memory SHA-256 hash verification during staging (default: 20MB) */
  maxVerifyBytes?: number;
  /** Whether files exceeding maxVerifyBytes skip in-memory verification in strict mode (default: true). Set to false to fail on oversized unverified files. */
  allowOversizedUnverified?: boolean;
  /** Glob patterns of files to exclude from SHA-256 hash verification during staging */
  skipVerifyGlobs?: string[];
  /** Default fallbackOn5xx behavior across routes */
  fallbackOn5xx?: boolean;
  /** Cache storage names */
  caches?: {
    offline?: string;
    runtime?: string;
    meta?: string;
  };
  /** Path inside offline cache where snapshot is stored */
  snapshotCachePath?: string;
  /** Files to pre-cache at SW install time (the app shell) - accepts URL strings, URLPattern instances, or pattern objects */
  precache?: (string | URLPatternInit | any)[];
  /** Per-URL-pattern fetch strategies */
  routes?: RouteConfig[];
  /** Strategy to use when no route matches (default: 'network-first') */
  defaultStrategy?: FetchStrategy;
  /** Default network timeout in ms for network-first strategy */
  networkTimeoutMs?: number;
  /** Default fallback URL for navigation requests when offline */
  navigationFallback?: string;
  /** Default offline fallback page URL (for navigation) */
  offlineFallback?: string;
  /** Enable Navigation Preload (boolean or custom header string, e.g. 'NLPWA-Preload') */
  navigationPreload?: boolean | string;
  /** Navigation URL patterns allowed to receive the SPA shell fallback (globs, RegExps, or predicates) */
  navigationAllowlist?: Array<string | RegExp | ((url: URL) => boolean)>;
  /** Navigation URL patterns excluded from receiving the SPA shell fallback (e.g. ['/api/**', '/admin/**']) */
  navigationDenylist?: Array<string | RegExp | ((url: URL) => boolean)>;
  /** Query parameters to ignore when matching and storing cache entries (e.g. [/^utm_/, /^fbclid$/]) */
  ignoreURLParametersMatching?: Array<string | RegExp>;
  /** Directory index filename when path ends with / (default: 'index.html') */
  directoryIndex?: string;
  /** Whether to match extensionless clean URLs against .html files (default: true) */
  cleanURLs?: boolean;
  /** Logging verbosity: 'silent' | 'error' | 'warn' | 'info' | 'debug' (default: 'info') */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** Base public path for assets and API endpoints (e.g. '/my-app/' for subpaths) */
  base?: string;
  /** Retain immediate prior version cache on commit for multi-tab grace retention */
  retainPreviousVersionCache?: boolean;
  /** Clear the entire runtime cache whenever a new app version is committed */
  clearRuntimeOnUpdate?: boolean;
  /** Whether to cache opaque cross-origin responses in runtime cache (default: false) */
  cacheOpaque?: boolean;
  /** Development & UI design mode: unregisters Service Worker, clears caches, and prevents auto-registration. Default: false */
  dev?: boolean;
  /** Development bypass mode flag. Default: false */
  devBypass?: boolean;
  /** Whether fetch failures should throw/reject instead of returning a synthetic 503 response */
  throwOnFailure?: boolean;
  /** Global plugins attached to all route strategies */
  plugins?: NLPWAPlugin[];
  /** Direct requestWillFetch hook shortcut */
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | Response | void> | Request | Response | void;
  /** Direct cachedResponseWillBeUsed hook shortcut */
  cachedResponseWillBeUsed?: (params: CachedResponseWillBeUsedParams) => Promise<Response | null | void> | Response | null | void;
  /** Direct cacheWillUpdate hook shortcut */
  cacheWillUpdate?: (params: CacheWillUpdateParams) => Promise<Response | null | boolean | void> | Response | null | boolean | void;
  /** Direct fetchDidSucceed hook shortcut */
  fetchDidSucceed?: (params: FetchDidSucceedParams) => Promise<Response | void> | Response | void;
  /** Direct fetchDidFail hook shortcut */
  fetchDidFail?: (params: FetchDidFailParams) => Promise<void> | void;
  /** Direct cacheDidUpdate hook shortcut */
  cacheDidUpdate?: (params: CacheDidUpdateParams) => Promise<void> | void;
  /** Direct cacheKeyWillBeUsed hook shortcut */
  cacheKeyWillBeUsed?: (params: CacheKeyWillBeUsedParams) => Promise<Request | string> | Request | string;
  /** Automatically clear app badge count when user clicks a notification (default: true) */
  clearBadgeOnClick?: boolean;
  /** Web Share Target configuration */
  shareTarget?: ShareTargetConfig;
  /** Web Share Target configuration alias */
  share_target?: ShareTargetConfig;
  /** Respect client navigator.connection.saveData by deferring staging */
  respectSaveData?: boolean;
  /** Maximum update network delta bytes allowed before rejecting staging */
  maxUpdateBytes?: number;
  /** Maximum update bytes allowed on cellular/metered connection before deferring staging to Wi-Fi */
  wifiOnlyThresholdBytes?: number;
  /** Staging budget & network-awareness options */
  staging?: {
    respectSaveData?: boolean;
    maxUpdateBytes?: number;
    wifiOnlyThresholdBytes?: number;
  };
  /** Threshold in bytes (>25MB) for large assets to delegate to Background Fetch / IndexedDB streaming */
  largeFileThresholdBytes?: number;
  /** Update application mode ('navigation' or 'immediate') */
  applyMode?: 'navigation' | 'immediate';
  /** Opt-in telemetry reporting */
  telemetry?: boolean | { url?: string };
  /** Multi-boot probation configuration for newly committed versions */
  probation?: boolean | {
    requiredHealthyBoots?: number;
    failureThreshold?: number;
    clientBlockTtlMs?: number;
  };
}

export interface ShareTargetFileParam {
  name: string;
  accept?: string[];
}

export interface ShareTargetParams {
  title?: string;
  text?: string;
  url?: string;
  files?: ShareTargetFileParam[];
}

export interface ShareTargetConfig {
  action: string;
  method?: 'GET' | 'POST';
  enctype?: 'application/x-www-form-urlencoded' | 'multipart/form-data';
  params?: ShareTargetParams;
  redirectUrl?: string;
  maxFileBytes?: number;
}

declare const defaultConfig: NLPWAConfig;
export default defaultConfig;
