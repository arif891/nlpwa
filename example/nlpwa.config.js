export default {
  version: '1.0.0',
  updateAPI: {
    version: '/api/update/version.json',
    info: '/api/update/info.json',
  },

  // App shell. Precached files are always served cache-first, so every
  // file the page needs to open offline belongs here.
  precache: [
    '/',
    '/index.html',
    '/assets/css/app.css',
    '/assets/js/app.js',
    '/assets/js/client.js',
    '/assets/font/Red_Hat_Display/Red_Hat_Display_regular_variable_v20.woff2',
    '/assets/font/Red_Hat_Mono/Red_Hat_Mono_regular_variable_v15.woff2',
    '/assets/icon/logo.svg',
    '/assets/icon/icon-192.png',
    '/assets/icon/icon-512.png',
    '/assets/icon/favicon.ico',
    '/assets/other/manifest.webmanifest',
    '/demo/cache-only.json',
  ],

  // One route per strategy, used by the Playground.
  routes: [
    { match: '/demo/cache-first.json', strategy: 'cache-first' },
    { match: '/demo/network-first.json', strategy: 'network-first' },
    { match: '/demo/swr.json', strategy: 'stale-while-revalidate' },
    { match: '/demo/network-only.json', strategy: 'network-only', throwOnFailure: true },
    { match: '/demo/cache-only.json', strategy: 'cache-only' },
    { match: '/api/live/*', strategy: 'network-only' },
  ],
  defaultStrategy: 'network-first',
};
