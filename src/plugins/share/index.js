export {
  ShareTargetPlugin,
  isShareTargetRequest,
  handleShareTarget,
  getLatestSharedData,
  SHARE_CACHE_NAME,
  SHARE_QUEUE_KEY,
  DEFAULT_MAX_FILE_BYTES,
} from './sw.js';

export {
  getSharedData,
  onShareTarget,
  ShareTargetClient,
  shareTargetClient,
} from './client.js';

export { SHARE_MESSAGE_TYPES } from './constants.js';
