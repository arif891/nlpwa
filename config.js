export default {
  // App version (auto-incremented by nlpwa update)
  version: '1.0.0',

  // Path to runtime config file (served by web server and stored in offline cache)
  configPath: '/config.json',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version',
    info: '/api/update/info',
  },

  // Update check polling interval (ms)
  updateCheckInterval: 60 * 60 * 1000,

  // App shell files to track and offline-cache
  precache: [
    '/',
    '/index.html',
  ],

  // Per-route fetch strategies
  routes: [
    { match: '/api/**',    strategy: 'network-only' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '**',         strategy: 'network-first' },
  ],

  defaultStrategy: 'network-first',
};
