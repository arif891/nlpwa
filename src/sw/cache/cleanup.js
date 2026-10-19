/**
 * Re-export storage quota and eviction routines from cache/eviction/ sub-package.
 */
export { getResponseMetadata, getStorageQuotaInfo } from './eviction/quota.js';
export { resolveByteSize } from './eviction/size.js';
export { cleanRuntimeCache } from './eviction/policies.js';
