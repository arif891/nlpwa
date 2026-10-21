export interface BackgroundFetchSuccessData {
  id: string;
  count: number;
  cacheName: string;
  storedRequests: string[];
}

export interface BackgroundFetchFailData {
  id: string;
  failureReason: string;
}

export interface BackgroundFetchAbortData {
  id: string;
}

export function isBackgroundFetchSupported(): boolean;

export declare class BackgroundFetchClient {
  constructor(options?: any);
  isSupported(): boolean;
  getRegistration(): Promise<ServiceWorkerRegistration | null>;
  fetch(id: string, requests: string[] | Request[], options?: {
    title?: string;
    icons?: Array<{ src: string; sizes?: string; type?: string }>;
    downloadTotal?: number;
  }): Promise<any>;
  get(id: string): Promise<any>;
  getIds(): Promise<string[]>;
  abort(id: string): Promise<boolean>;
  onSuccess(callback: (data: BackgroundFetchSuccessData) => void): () => void;
  onFail(callback: (data: BackgroundFetchFailData) => void): () => void;
  onAbort(callback: (data: BackgroundFetchAbortData) => void): () => void;
}

export declare const backgroundFetchClient: BackgroundFetchClient;

export declare class BackgroundFetchPlugin {
  constructor(options?: { cacheName?: string; clickUrl?: string });
}

export function handleBackgroundFetchSuccess(event: any, options?: { cacheName?: string }): Promise<void>;
export function handleBackgroundFetchFail(event: any): Promise<void>;
export function handleBackgroundFetchAbort(event: any): Promise<void>;
export function handleBackgroundFetchClick(event: any, options?: { clickUrl?: string }): Promise<void>;
export function setupBackgroundFetchListeners(options?: any): void;
