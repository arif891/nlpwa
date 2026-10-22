# NLPWA — Plugin System & Extensions

NLPWA features a modular, zero-dependency plugin architecture. You can attach plugins to specific route definitions to intercept request and response lifecycles, or use official extensions for offline mutations, background transfers, native OS integration, and cryptographic security.

---

## Modular Documentation

Detailed documentation for the plugin system and all official plugins is organized in the [`docs/plugins/`](plugins/README.md) directory:

- 🔌 [**Plugin Architecture & Lifecycle Hooks**](plugins/README.md) — How hooks work, request/response interception, and authoring custom plugins.
- 🔄 [**Background Sync (`nlpwa/sync`)**](plugins/SYNC.md) — Offline mutation queueing with FIFO replay, dead-letter store, and cross-browser fallbacks.
- 📥 [**Background Fetch (`nlpwa/bg-fetch`)**](plugins/BG-FETCH.md) — Background large-asset downloads & uploads with OS progress bars, URL detection, and IDB streaming.
- 📲 [**Web Share Target (`nlpwa/share`)**](plugins/SHARE.md) — Native share sheet integration and offline media hydration.
- 🏷️ [**OS App Badging (`nlpwa/badge`)**](plugins/BADGE.md) — Application icon counter control and push notification clearance.
- 🔐 [**Cryptographic Verification (`nlpwa/crypto`)**](plugins/CRYPTO.md) — Ed25519 detached signatures and Web Crypto verification.

---

## Quick Example: Attaching Plugins to Routes

```javascript
// nlpwa.config.js
import { BackgroundSyncPlugin } from 'nlpwa/sync';
import { BackgroundFetchPlugin } from 'nlpwa/bg-fetch';

export default {
  routes: [
    {
      match: '/api/mutations/**',
      strategy: 'network-only',
      plugins: [
        new BackgroundSyncPlugin({ queueName: 'mutations' }),
      ],
    },
  ],
};
```
