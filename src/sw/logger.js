import { getConfig } from './config/index.js';
import { createLogger } from '../shared/logger.js';

export const logger = createLogger(getConfig);
export default logger;
