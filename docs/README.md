# NLPWA Documentation Portal

Welcome to the comprehensive documentation for **NLPWA** — the native-like PWA framework with install-time caching and atomic hash-based delta updates.

---

## 📚 Documentation Sitemap

### Core Architecture & Protocols
- 📐 [**Architecture Guide**](ARCHITECTURE.md) — System design, internal module map, version pinning, and the atomic state machine.
- 📦 [**Update Protocol Spec**](UPDATE-PROTOCOL.md) — Two-tier JSON manifests, SHA-256 content hashing format, and background staging lifecycle.
- 🚦 [**Fetch Strategies**](STRATEGIES.md) — Visual lifecycles for `cache-first`, `network-first`, `stale-while-revalidate`, `network-only`, and `cache-only`.
- 🛠️ [**CLI & Tooling**](CLI.md) — `nlpwa init`, `nlpwa update`, `nlpwa add`, Rollup/Vite plugins, and CI/CD setup.

---

### Application Configuration ([`docs/config/`](config/README.md))
- ⚙️ [**Global Options Schema**](config/OPTIONS.md) — Versions, endpoints, caches, multi-boot probation, hash verification, staging budgets, and security keys.
- 🚦 [**Routes & Strategies**](config/ROUTES.md) — Glob pattern rules, CDN/cross-origin caching, fallbacks, clean URLs, and tracking parameter stripping.

---

### Client SDK & Runtime API ([`docs/client/`](client/README.md))
- 📋 [**Registration & Updates**](client/REGISTRATION.md) — Service Worker initialization, polling intervals, staging progress callbacks, and update activation.
- 🔄 [**Multi-Tab Coherence & Version Pinning**](client/COHERENCE.md) — Version pinning, tab leader election, and dirty form reload guards.
- 📊 [**Reactive State & Diagnostics**](client/STATE.md) — Unified state store (`getState()`, `subscribe()`), boot watchdog, probation, and `diagnostics()`.
- 💾 [**Storage Quotas & Cleanup**](client/STORAGE.md) — Quota inspection, persistent storage permissions, and LRU runtime cache eviction.
- 📱 [**PWA Installation Manager**](client/INSTALLER.md) — `beforeinstallprompt` manager, standalone mode detection, and programmatic install triggers.

---

### Modular Plugins Ecosystem ([`docs/plugins/`](plugins/README.md))
- 🔌 [**Plugin Architecture & Lifecycle Hooks**](plugins/README.md) — How hooks work and how to write custom plugins.
- 🔄 [**Background Sync (`nlpwa/sync`)**](plugins/SYNC.md) — Offline mutation queueing with FIFO replay, dead-letter store, and cross-browser fallbacks.
- 📥 [**Background Fetch (`nlpwa/bg-fetch`)**](plugins/BG-FETCH.md) — Large file background downloads & uploads with native OS progress bars and IDB streaming.
- 📲 [**Web Share Target (`nlpwa/share`)**](plugins/SHARE.md) — Intercepting native mobile share sheet submissions with offline media hydration.
- 🏷️ [**OS App Badging (`nlpwa/badge`)**](plugins/BADGE.md) — Desktop/mobile icon badge counters and push notification clearance.
- 🔐 [**Cryptographic Verification (`nlpwa/crypto`)**](plugins/CRYPTO.md) — Detached Ed25519 signature signing and Web Crypto verification.
