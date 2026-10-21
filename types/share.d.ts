export interface SharedFileData {
  name: string;
  type: string;
  size: number;
  lastModified?: number;
  url?: string;
  blob?: Blob;
  error?: string;
}

export interface SharedDataPayload {
  id?: string;
  title: string;
  text: string;
  url: string;
  files: SharedFileData[];
  timestamp?: number;
}

export interface ShareTargetPluginOptions {
  action?: string;
  method?: 'GET' | 'POST';
  enctype?: string;
  redirectUrl?: string;
  maxFileBytes?: number;
  params?: {
    title?: string;
    text?: string;
    url?: string;
    files?: Array<{ name: string; accept?: string[] }>;
  };
}

export declare class ShareTargetPlugin {
  constructor(options?: ShareTargetPluginOptions);
  requestWillFetch(context: { request: Request; event: any }): Promise<Response | void>;
}

export function isShareTargetRequest(request: Request, config?: any): boolean;
export function handleShareTarget(event: any, config?: any): Promise<Response>;
export function getLatestSharedData(): Promise<SharedDataPayload | null>;
export function getSharedData(): Promise<SharedDataPayload | null>;
export function onShareTarget(callback: (data: SharedDataPayload) => void): () => void;

export declare class ShareTargetClient {
  getSharedData(): Promise<SharedDataPayload | null>;
  onShareTarget(callback: (data: SharedDataPayload) => void): () => void;
}

export declare const shareTargetClient: ShareTargetClient;
