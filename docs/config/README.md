# NLPWA — Configuration Reference

NLPWA cleanly separates **Service Worker engine initialization** (`sw.js`) from **Application configuration** (`nlpwa.config.js`).

---

## Modular Documentation

Detailed configuration guides are organized into focused documents:

- ⚙️ [**Global Options Schema (`OPTIONS.md`)**](OPTIONS.md) — Reference for versions, update endpoints, caches, multi-boot probation, hash verification, staging budgets, and security keys.
- 🚦 [**Routing & Strategies (`ROUTES.md`)**](ROUTES.md) — Per-route glob matching, fetch strategies, cross-origin/CDN handling, navigation fallbacks, cache keys, and route plugins.
- 🔌 [**Plugin System Guide (`../plugins/README.md`)**](../plugins/README.md) — Writing custom plugins and configuring official extensions (`sync`, `bg-fetch`, `share`, `badge`, `crypto`).

---

## 1. Service Worker Initialization (`sw.js`)

In your `sw.js`, call `initSW()` with the SW engine version:

```javascript
import { initSW } from 'nlpwa/sw';

initSW({
  // SW engine logic version — managed manually by the developer
  version: '1',

  // Path to runtime config file (read from and stored in offline cache)
  configPath: '/api/update/config.json',
});
```

---

## 2. Application Configuration (`nlpwa.config.js`)

Developers define routes, precached shell files, and update settings in `nlpwa.config.js`.

When running `nlpwa update` (or using the Vite/Rollup plugins), the CLI automatically scans your build assets, expands globs, hashes files with SHA-256, and outputs the runtime `api/update/config.json`.

```javascript
export default {
  // Application base version
  version: '1.0.0',

  // Two-tier update endpoints
  updateAPI: {
    version: '/api/update/version.json',
    info:    '/api/update/info.json',
  },

  // App shell files to track & offline-cache
  precache: [
    '/',
    '/index.html',
    '/app.js',
    '/styles/main.css',
    '/assets/icons/**',
  ],

  // Per-route fetch strategies
  routes: [
    { match: '/api/**',    strategy: 'network-only' },
    { match: '/assets/**', strategy: 'cache-first' },
    { match: '**',         strategy: 'network-first' },
  ],
};
```

---

## Configuration Validation

NLPWA validates your configuration against a strict internal schema at startup:
- Invalid options log informative warnings to the Service Worker console starting with `[NLPWA]`.
- The Service Worker merges invalid options with safe defaults rather than throwing, ensuring the app remains resilient and never breaks in production.
