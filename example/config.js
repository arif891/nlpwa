export default {
  version: '1.0.0',
  configPath: '/config.json',
  updateAPI: {
    version: '/api/update/version.json',
    info: '/api/update/info.json',
  },
  precache: [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/client.js',
    '/manifest.webmanifest',
    '/offline-data.json',
    '/assets/offline-badge.svg',
    '/assets/theme.json',
  ],
  routes: [
    { match: '/api/live/**', strategy: 'network-only' },
    { match: '/api/feed.json', strategy: 'stale-while-revalidate' },
    { match: '/api/profile.json', strategy: 'network-first' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '/offline-data.json', strategy: 'cache-only' },
  ],
  defaultStrategy: 'network-first',
};
