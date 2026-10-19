import type { ReplayResult } from './sync.d.ts';

export interface PendingSyncItem {
  id: number;
  url: string;
  method: string;
  timestamp: number;
  retryCount: number;
}

export interface PendingSyncInfo {
  queue: string;
  count: number;
  items: PendingSyncItem[];
}

export class SyncClient {
  defaultQueue: string;
  constructor(defaultQueue?: string);
  on(event: 'enqueued' | 'success' | 'failed', callback: (data: any) => void): () => void;
  getPending(queueName?: string, options?: { timeoutMs?: number }): Promise<PendingSyncInfo>;
  replay(queueName?: string, options?: { timeoutMs?: number }): Promise<ReplayResult>;
  clear(queueName?: string, options?: { timeoutMs?: number }): Promise<boolean>;
  autoSyncOnOnline(queueName?: string): () => void;
}

export const syncClient: SyncClient;
