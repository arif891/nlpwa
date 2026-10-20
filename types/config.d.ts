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
  /** Called before a network request is made; can return a modified Request */
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | void> | Request | void;
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
}

export interface RouteConfig {
  /** Glob pattern to match request URL pathname (e.g. '/api/**', '/assets/*') */
  match: string;
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
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | void> | Request | void;
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
  /** Minimum required version; clients below this version are prompted/forced to update */
  minVersion?: string;
  /** Minimum supported version alias; clients below this version are prompted/forced to update */
  minSupportedVersion?: string;
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
  /** Hash verification mode for update downloads */
  verifyHashes?: 'strict' | 'warn' | false;
  /** Maximum file size in bytes for in-memory SHA-256 hash verification during staging (default: 20MB) */
  maxVerifyBytes?: number;
  /** Explicit opt-in to allow files exceeding maxVerifyBytes to skip in-memory verification in strict mode (default: false) */
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
  /** Files to pre-cache at SW install time (the app shell) */
  precache?: string[];
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
  /** Enable development mode (bypasses Vite dev server and HMR requests directly to network). Default: false */
  dev?: boolean;
  /** Explicitly bypass Vite dev server and HMR requests directly to network. Default: false */
  devBypass?: boolean;
  /** Whether fetch failures should throw/reject instead of returning a synthetic 503 response */
  throwOnFailure?: boolean;
  /** Global plugins attached to all route strategies */
  plugins?: NLPWAPlugin[];
  /** Direct requestWillFetch hook shortcut */
  requestWillFetch?: (params: RequestWillFetchParams) => Promise<Request | void> | Request | void;
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
}

declare const defaultConfig: NLPWAConfig;
export default defaultConfig;
