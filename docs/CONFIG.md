# NLPWA — Configuration Reference

NLPWA separates **Service Worker engine initialization** (`sw.js`) from **Application configuration** (`nlpwa.config.js`).

---

## Modular Documentation

Detailed configuration guides are organized in the [`docs/config/`](config/README.md) directory:

- ⚙️ [**Global Options Schema**](config/OPTIONS.md) — Reference for versions, update endpoints, caches, multi-boot probation, hash verification, staging budgets, and security keys.
- 🚦 [**Routing & Strategies**](config/ROUTES.md) — Per-route glob matching, fetch strategies, cross-origin/CDN handling, navigation fallbacks, cache keys, and route plugins.
- 🔌 [**Plugin System Guide**](plugins/README.md) — Writing custom plugins and configuring official extensions (`sync`, `bg-fetch`, `share`, `badge`, `crypto`).

---

## Quick Example

### `sw.js` (Service Worker Engine)

```javascript
import { initSW } from 'nlpwa/sw';

initSW({
  version: '1',
  configPath: '/api/update/config.json',
});
```

### `nlpwa.config.js` (Application Configuration)

```javascript
export default {
  version: '1.0.0',
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
  ],
  routes: [
    { match: '/api/**',    strategy: 'network-only' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '**',         strategy: 'network-first' },
  ],
};
```
