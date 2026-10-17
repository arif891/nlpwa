/**
 * Standalone Service Worker entry (built to out/sw.js, the file `nlpwa init` copies).
 *
 * It starts the engine with the defaults below. Everything app-specific
 * (routes, precache list, update endpoints) lives in /config.json, which is
 * stored in the offline cache and applied as soon as it is available.
 *
 * `updateAPI` is set here because the very first install runs before
 * /config.json has been cached, so the engine needs to know where the update
 * manifest is. These match the starter config.js. If you serve the update API
 * elsewhere, build your own entry:
 *
 *   import { initSW } from 'nlpwa/sw';
 *   initSW({ version: '1', updateAPI: { version: '/v', info: '/i' } });
 */
import { initSW } from './index.js';

initSW({
  version: '1',
  configPath: '/config.json',
  updateAPI: {
    version: '/api/update/version.json',
    info: '/api/update/info.json',
  },
});
