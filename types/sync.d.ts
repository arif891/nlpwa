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
  replayAll(options?: {
    fetchImpl?: typeof fetch;
    onReplaySuccess?: (item: any, response: Response) => void;
    onReplayFail?: (item: any, error: any) => void;
  }): Promise<ReplayResult>;
}

export { SyncClient, syncClient } from './sync-client';
