import type { ReplayResult } from './sync';

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
  getDeadLetter(queueName?: string, options?: { timeoutMs?: number }): Promise<Array<any>>;
  retryDeadLetter(id: number, queueName?: string, options?: { timeoutMs?: number }): Promise<boolean>;
  clearDeadLetter(queueName?: string, options?: { timeoutMs?: number }): Promise<boolean>;
  clearOnLogout(): Promise<void>;
  getAuthRequired(queueName?: string): Promise<Array<any>>;
  retryAuthRequired(queueName?: string, id?: number): Promise<number>;
  autoSyncOnOnline(queueName?: string): () => void;
  destroy?(): void;
}

export const syncClient: SyncClient;
