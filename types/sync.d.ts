export interface BackgroundSyncOptions {
  queueName?: string;
  maxRetentionMs?: number;
  maxRetries?: number;
  methods?: string[];
  allMethods?: boolean;
}

export interface ReplayResult {
  successCount: number;
  failedCount: number;
  remainingCount: number;
}

export class BackgroundSyncPlugin {
  queueName: string;
  constructor(options?: string | BackgroundSyncOptions);
  fetchDidFail(context: {
    request: Request;
    originalRequest?: Request;
    error: Error;
    event?: any;
  }): Promise<void>;
  replay(): Promise<ReplayResult>;
}

export class SyncQueue {
  name: string;
  maxRetentionMs: number;
  maxRetries: number;
  constructor(name?: string, options?: BackgroundSyncOptions);
  push(request: Request, extraMeta?: Record<string, any>): Promise<number>;
  getAll(): Promise<Array<any>>;
  size(): Promise<number>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
  getDeadLetter(): Promise<Array<any>>;
  retryDeadLetter(id: number): Promise<boolean>;
  clearDeadLetter(): Promise<void>;
  getAuthRequired(): Promise<Array<any>>;
  retryAuthRequired(id?: number): Promise<number>;
  replayAll(options?: {
    fetchImpl?: typeof fetch;
    onReplaySuccess?: (item: any, response: Response) => void;
    onReplayFail?: (item: any, error: any) => void;
  }): Promise<ReplayResult>;
  static clearAll(): Promise<void>;
}

export class PeriodicSyncPlugin {
  constructor(options?: {
    tags?: Record<string, (event: any) => Promise<any> | void>;
    onSync?: (event: any) => Promise<any> | void;
  });
  on(tag: string, handler: (event: any) => Promise<any> | void): this;
  onPeriodicSync(event: any): void;
}

export function isPeriodicSyncSupported(): boolean;
export function getPeriodicSyncPermission(): Promise<string>;
export function registerPeriodicSync(tag: string, options?: {
  minInterval?: number;
  onSync?: () => Promise<void> | void;
  allowFallback?: boolean;
  registration?: ServiceWorkerRegistration;
}): Promise<{ registered: boolean; strategy: 'native' | 'fallback' | 'none'; tag: string; minInterval: number }>;
export function unregisterPeriodicSync(tag: string, options?: { registration?: ServiceWorkerRegistration }): Promise<boolean>;
export function getPeriodicSyncTags(options?: { registration?: ServiceWorkerRegistration }): Promise<string[]>;

export class PeriodicSyncClient {
  isSupported(): boolean;
  getPermission(): Promise<string>;
  register(tag: string, options?: any): Promise<any>;
  unregister(tag: string, options?: any): Promise<boolean>;
  getTags(options?: any): Promise<string[]>;
}

export const periodicSyncClient: PeriodicSyncClient;

export { SyncClient, syncClient } from './sync-client';
