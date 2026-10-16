/**
 * NLPWA Configuration
 *
 * Edit this file to configure offline caching and route fetch strategies.
 * The NLPWA build tool (nlpwa update / rollup plugin) reads this file,
 * auto-increments the app version, and emits runtime config.json and update APIs.
 */
export default {
  // App version (auto-incremented on build/update)
  version: '1.0.0',

  // Path to runtime config file (served by web server, stored in offline cache)
  configPath: '/config.json',

  // Two-tier update check endpoints
  updateAPI: {
    version: '/api/update/version',
    info: '/api/update/info',
  },

  // Update polling interval in ms (set to 0 to disable periodic polling)
  updateCheckInterval: 60 * 60 * 1000, // 1 hour

  // App shell files to track and offline-cache (tracked alongside config.json)
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
  ],

  // Per-route fetch strategies (glob pattern matching evaluated top-to-bottom)
  routes: [
    { match: '/api/**',    strategy: 'network-only' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '**',         strategy: 'network-first' },
  ],

  // Fallback strategy for unmatched routes
  defaultStrategy: 'network-first',
};
