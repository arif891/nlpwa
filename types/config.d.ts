export type FetchStrategy =
  | 'cache-first'
  | 'network-first'
  | 'network-only'
  | 'stale-while-revalidate'
  | 'cache-only';

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
  /** Whether to cache opaque cross-origin responses (default: false to prevent ~7MB Chrome quota padding and caching 404s) */
  cacheOpaque?: boolean;
}

export interface UpdateAPIConfigObject {
  /** Lightweight check returning { version: string } */
  version: string;
  /** Full manifest check returning { version: string, files: Array<{ path: string, hash: string }> } */
  info: string;
}

export interface UpdateAPIEndpointEntry {
  type: 'version' | 'info';
  endpoint: string;
}

export type UpdateAPIConfig = UpdateAPIConfigObject | UpdateAPIEndpointEntry[];

export interface NLPWAConfig {
  /** Service Worker / App version */
  version?: string;
  /** App version override when distinct from SW version */
  appVersion?: string;
  /** Path to runtime config.json file (default: '/config.json') */
  configPath?: string;
  /** Two-tier update check endpoints */
  updateAPI?: UpdateAPIConfig;
  /** Hash verification mode for update downloads */
  verifyHashes?: 'strict' | 'warn' | false;
  /** Maximum file size in bytes for in-memory SHA-256 hash verification during staging (default: 20MB) */
  maxVerifyBytes?: number;
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
}

declare const defaultConfig: NLPWAConfig;
export default defaultConfig;
