/**
 * NLPWA Configuration
 *
 * Edit this file to configure offline caching and route fetch strategies.
 * The NLPWA build tool (nlpwa update / rollup plugin) reads this file,
 * derives the app version from manifest content hashes, and emits runtime config.json and update APIs.
 */
export default {
  // Base app version (used as prefix for content-derived version: <version>-<12-char hash>)
  version: '1.0.0',

  // Path to runtime config file (served by web server, stored in offline cache)
  configPath: '/config.json',

  // Two-tier update check endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info: '/api/update/info.json',
  },

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
