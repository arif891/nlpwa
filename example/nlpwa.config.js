export default {
  version: '1.0.0',
  configPath: '/api/config/config.json',
  updateAPI: {
    version: '/api/update/version.json',
    info: '/api/update/info.json',
  },
  precache: [
    '/',
    '/index.html',
  
  ],
  routes: [
    { match: '/api/live/*', strategy: 'network-only' },
  ],
  defaultStrategy: 'network-first',
};
