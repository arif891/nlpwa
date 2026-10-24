# NLPWA — Native-like PWA Framework

[![npm version](https://img.shields.io/npm/v/nlpwa.svg?color=0284c7&style=flat-square)](https://www.npmjs.com/package/nlpwa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Zero Runtime Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg?style=flat-square)](https://github.com/arif891/nlpwa)
[![Tests Passing](https://img.shields.io/badge/tests-391%20passing-brightgreen.svg?style=flat-square)](https://github.com/arif891/nlpwa)
[![Standalone SW Size](https://img.shields.io/badge/standalone%20SW-~26%20KB%20gz-informational.svg?style=flat-square)](https://github.com/arif891/nlpwa)
[![Client SDK Size](https://img.shields.io/badge/client%20SDK-~10%20KB%20gz-informational.svg?style=flat-square)](https://github.com/arif891/nlpwa)

A lightweight, zero-dependency Service Worker engine and client SDK that makes Progressive Web Apps feel truly native. It delivers **atomic over-the-air (OTA) delta updates**, **per-tab client version pinning**, **automated boot watchdog rollbacks**, and **modular native OS integrations** (Push, Sync, Badging, Share Target, Background Fetch).

---

## ⚡ Quickstart in 60 Seconds

### 1. Install & Initialize
Scaffold your service worker and default configuration into your project or build output directory:
```bash
npm install nlpwa
npx nlpwa init --dir ./public
```

### 2. Register in Your App
Import and register the client SDK in your main entrypoint:
```javascript
import { register, onUpdateAvailable, applyUpdate } from 'nlpwa/client';

register();

onUpdateAvailable((info) => {
  console.log(`Update v${info.version} staged in background!`);
  // Optionally prompt user or call applyUpdate() to activate immediately
});
```

### 3. Build & Deploy Updates
Whenever you deploy a new build, generate hash-verified update manifests with the CLI:
```bash
npx nlpwa update --dir ./dist
```
This generates:
- `dist/api/update/version.json` — Tier 1 lightweight ~20-byte check endpoint
- `dist/api/update/info.json` — Tier 2 hash-verified file manifest
- `dist/api/update/config.json` — Deployed runtime configuration

---

## 🚀 Core Highlights

- **Atomic Background Staging**: Updates download into an isolated staging cache. The live app is never touched until 100% of files are verified.
- **Zero Version Drift (Client Pinning)**: Each open tab stays pinned to its boot cache. Lazy-loaded chunks never trigger `404 ChunkLoadError`.
- **Health-Gated Boot Rollbacks**: If a newly deployed version crashes or fails to mark healthy, the Service Worker automatically rolls back to the previous fallback version.
- **Canary & Phased Rollouts**: Target canary cohorts via `rolloutPercent: 20`, isolate release `channel` (`stable`/`beta`), or revoke bad releases origin-wide via `blockedVersions`.
- **Precache Atomicity Guarantee**: App shell files in `config.precache` are strictly cache-first. Staging deltas never mutate active tabs mid-session.
- **Modular Native OS Plugins**: Drop-in plugins for Web Push (`nlpwa/push`), Background Sync (`nlpwa/sync`), Periodic Sync (`nlpwa/sync/periodic`), App Badging (`nlpwa/badge`), Web Share Target (`nlpwa/share`), and Background Fetch (`nlpwa/bg-fetch`).

---

## 🛠️ Bundler Integration

### Vite / Rollup
```javascript
// vite.config.js
import { nlpwaPlugin } from 'nlpwa/vite';

export default {
  plugins: [
    nlpwaPlugin({
      generateManifest: true,
      distDir: './dist',
    }),
  ],
};
```

### Webpack
```javascript
// webpack.config.js
const { NlpwaWebpackPlugin } = require('nlpwa/webpack');

module.exports = {
  plugins: [new NlpwaWebpackPlugin()],
};
```

---

## 📚 Documentation

Deep-dive architectural specifications, guides, and API references:

| Guide | Description |
|---|---|
| [**Architecture & Design**](docs/ARCHITECTURE.md) | Cache partitioning, active pointers, two-tier polling, and lifecycle decoupling |
| [**Update Protocol Specification**](docs/UPDATE-PROTOCOL.md) | Two-tier update protocol, manifest schema, sequence checking, and signatures |
| [**CLI Command Reference**](docs/CLI.md) | `nlpwa init`, `nlpwa update`, `nlpwa keys`, `nlpwa status`, and CI automation |
| [**Configuration Options**](docs/CONFIG.md) | Complete `nlpwa.config.js` reference, caching strategies, and budgets |
| [**Caching Strategies**](docs/STRATEGIES.md) | `cache-first`, `network-first`, `stale-while-revalidate`, RFC 7233 range requests |
| [**Client SDK & Events**](docs/CLIENT-API.md) | State store, event hooks, dirty form guards, leader election, and diagnostics |
| [**Plugin Ecosystem**](docs/PLUGINS.md) | Background Sync, Web Push, Share Target, Badging, and Background Fetch |
| [**Features Overview**](docs/FEATURES.md) | Complete feature breakdown, Workbox comparison, and enterprise dial-in |

---

## 🎮 Interactive Demo
Explore the live interactive testbed demonstrating delta updates, tab pinning, and badging:
```bash
npm run example
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## License
[MIT](LICENSE)
