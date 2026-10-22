export function isBadgingSupported(): boolean;
export function isBadgeSupported(): boolean;
export function setAppBadge(count?: number | null): Promise<boolean>;
export function setBadge(count?: number | null): Promise<boolean>;
export function clearAppBadge(): Promise<boolean>;
export function clearBadge(): Promise<boolean>;

export declare class BadgeClient {
  isSupported(): boolean;
  set(count?: number | null): Promise<boolean>;
  clear(): Promise<boolean>;
}

export declare const badgeClient: BadgeClient;

export declare class BadgePlugin {
  constructor(options?: { clearOnClick?: boolean });
  onNotificationClick(event: any): void;
  onPush(event: any, payload: any): void;
}

export function clearBadgeOnNotificationClick(event: any): void;
export function setBadgeFromPush(event: any, payload: any): void;
