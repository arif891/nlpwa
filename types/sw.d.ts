import type { NLPWAConfig } from './config';

/**
 * Initialize the NLPWA Service Worker.
 *
 * @param userConfig User configuration overrides.
 */
export function initSW(userConfig?: Partial<NLPWAConfig>): void;

export type {
  NLPWAConfig,
  RouteConfig,
  FetchStrategy,
  UpdateAPIConfig,
  UpdateAPIConfigObject,
} from './config';
