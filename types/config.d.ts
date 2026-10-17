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
  /** Ignore URL search query parameters when matching cache */
  ignoreSearch?: boolean;
}

export interface UpdateAPIConfigObject {
  /** Lightweight check returning { version: string } */
  version?: string;
  /** Full manifest check returning { version: string, files: Array<{ path: string, hash: string }> } */
  info?: string;
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
  /** How often (in ms) to poll for updates (0 to disable) */
  updateCheckInterval?: number;
  /** Hash verification mode for update downloads */
  verifyHashes?: 'strict' | 'warn' | false;
  /** Cache storage names */
  caches?: {
    offline?: string;
    runtime?: string;
  };
  /** Path inside offline cache where manifest snapshot is stored */
  manifestCachePath?: string;
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
}

declare const defaultConfig: NLPWAConfig;
export default defaultConfig;
