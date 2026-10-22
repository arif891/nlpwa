export interface PushSubscribeOptions {
  vapidPublicKey: string;
  userVisibleOnly?: boolean;
  registration?: ServiceWorkerRegistration;
}

export interface PushSubscribeResult {
  success: boolean;
  subscription?: PushSubscription;
  json?: any;
  reason?: string;
  permission?: string;
  error?: Error;
}

export interface PushPluginOptions {
  onPush?: (event: any, payload: any) => Promise<any> | void;
  onNotificationClick?: (event: any) => Promise<any> | void;
  actions?: Record<string, (event: any) => Promise<any> | void>;
  defaultUrl?: string;
  showNotification?: boolean;
}

export class PushPlugin {
  constructor(options?: PushPluginOptions);
  onPush(event: any, payload?: any): void;
  onNotificationClick(event: any): void;
}

export function isPushSupported(): boolean;
export function getPushPermission(): NotificationPermission | 'unsupported';
export function urlBase64ToUint8Array(base64String: string): Uint8Array;
export function getPushSubscription(options?: { registration?: ServiceWorkerRegistration }): Promise<PushSubscription | null>;
export function subscribePush(options: PushSubscribeOptions): Promise<PushSubscribeResult>;
export function unsubscribePush(options?: { registration?: ServiceWorkerRegistration }): Promise<boolean>;

export class PushClient {
  constructor(options?: { vapidPublicKey?: string });
  isSupported(): boolean;
  getPermission(): NotificationPermission | 'unsupported';
  getSubscription(options?: { registration?: ServiceWorkerRegistration }): Promise<PushSubscription | null>;
  subscribe(options?: PushSubscribeOptions): Promise<PushSubscribeResult>;
  unsubscribe(options?: { registration?: ServiceWorkerRegistration }): Promise<boolean>;
}

export const pushClient: PushClient;
