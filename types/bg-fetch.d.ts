export interface BackgroundFetchSuccessData {
  id: string;
  count: number;
  cacheName: string;
  caches?: string[];
  storedRequests: string[];
  uploadResults?: Array<{ url: string; method: string; status: number; response: any }>;
  isUpload?: boolean;
}

export interface BackgroundFetchFailData {
  id: string;
  failureReason: string;
}

export interface BackgroundFetchAbortData {
  id: string;
}

export interface BackgroundFetchProgressReport {
  id: string;
  downloaded: number;
  downloadTotal: number;
  uploaded: number;
  uploadTotal: number;
  percent: number | null;
}

export interface BackgroundFetchOptions {
  title?: string;
  icons?: Array<{ src: string; sizes?: string; type?: string }>;
  downloadTotal?: number;
  uploadTotal?: number;
  autoDetermineTotals?: boolean;
  onProgress?: (progress: BackgroundFetchProgressReport) => void;
}

export function isBackgroundFetchSupported(): boolean;
export function getBgFetchIdForUrl(url: string): string;
export function getUrlFromBgFetchId(id: string): string | null;

export declare class BackgroundFetchClient {
  constructor(options?: any);
  isSupported(): boolean;
  getRegistration(): Promise<ServiceWorkerRegistration | null>;
  fetch(id: string, requests: string | Request | string[] | Request[], options?: BackgroundFetchOptions): Promise<any>;
  fetch(requests: string | Request | string[] | Request[], options?: BackgroundFetchOptions): Promise<any>;
  get(id: string): Promise<any>;
  getForUrl(url: string): Promise<any>;
  onProgress(target: any | string, callback: (progress: BackgroundFetchProgressReport) => void): () => void;
  getIds(): Promise<string[]>;
  abort(id: string): Promise<boolean>;
  onSuccess(callback: (data: BackgroundFetchSuccessData) => void): () => void;
  onFail(callback: (data: BackgroundFetchFailData) => void): () => void;
  onAbort(callback: (data: BackgroundFetchAbortData) => void): () => void;
}

export declare const backgroundFetchClient: BackgroundFetchClient;

export declare class BackgroundFetchPlugin {
  constructor(options?: {
    cacheName?: string;
    clickUrl?: string;
    title?: string;
    icons?: Array<{ src: string; sizes?: string; type?: string }>;
    successTitle?: string;
    successIcons?: Array<{ src: string; sizes?: string; type?: string }>;
    failTitle?: string;
  });
}

export function handleBackgroundFetchSuccess(event: any, options?: any): Promise<void>;
export function handleBackgroundFetchFail(event: any, options?: any): Promise<void>;
export function handleBackgroundFetchAbort(event: any): Promise<void>;
export function handleBackgroundFetchClick(event: any, options?: { clickUrl?: string }): Promise<void>;
export function setupBackgroundFetchListeners(options?: any): void;

