# NLPWA — Client SDK & Runtime API

The NLPWA Client SDK (`client.js` or `nlpwa/client`) manages Service Worker registration, over-the-air update lifecycles, multi-tab version coherence, dirty form protection, and storage quotas.

It is available as both an ES module (`import { register, nlpwa } from 'nlpwa/client'`) and a pre-bundled standalone script (`/client.js`) defining `window.NLPWAClient`.

---

## Modular Documentation

Detailed guides for the Client SDK are organized in the [`docs/client/`](client/README.md) directory:

- 📋 [**Registration & Updates**](client/REGISTRATION.md) — Service Worker initialization, polling options, staging progress callbacks, and update activation.
- 🔄 [**Multi-Tab Coherence & Version Pinning**](client/COHERENCE.md) — Multi-tab consensus, tab leader election, version pinning, and dirty form reload guards.
- 📊 [**Reactive State & Diagnostics**](client/STATE.md) — Unified reactive state store (`getState()`, `subscribe()`), boot watchdog, probation, and `diagnostics()`.
- 💾 [**Storage Quotas & Cleanup**](client/STORAGE.md) — Disk quota monitoring, persistent storage permissions, and LRU runtime cache cleanup.
- 📱 [**PWA Installation Manager**](client/INSTALLER.md) — Capturing `beforeinstallprompt`, detecting standalone mode, and controlling custom install buttons.
- 📥 [**Background Fetch Client API**](plugins/BG-FETCH.md) — Background large-asset downloads & uploads with OS progress bars, URL detection, and IDB streaming.

---

## Quick Example

```javascript
import { register, nlpwa } from 'nlpwa/client';

// Register Service Worker with update notifications
register('/sw.js', {
  onUpdateReady: ({ version }) => {
    document.getElementById('update-banner').hidden = false;
  },
});

// Reactively subscribe to app state
nlpwa.subscribe((state) => {
  console.log(`Current state: ${state.status}, Version: ${state.version}`);
});
```
