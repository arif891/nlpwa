# NLPWA — Client SDK & Runtime API

The NLPWA Client SDK (`client.js` or `nlpwa/client`) manages Service Worker registration, over-the-air update lifecycles, multi-tab version coherence, dirty form protection, and storage quotas.

It is available as both an ES module (`import { register } from 'nlpwa/client'`) and a pre-bundled standalone script (`/client.js`) defining `window.NLPWAClient`.

---

## Modular Documentation

The Client SDK documentation is organized into modular guides:

- 📋 [**Registration & Updates (`REGISTRATION.md`)**](REGISTRATION.md) — Service Worker initialization, update check triggers, staging progress observation, and atomic commit activation.
- 🔄 [**Multi-Tab Coherence & Pinning (`COHERENCE.md`)**](COHERENCE.md) — Multi-tab consensus, tab leader election, version pinning, and dirty form reload guards.
- 📊 [**Reactive State & Diagnostics (`STATE.md`)**](STATE.md) — Unified reactive state store (`getState()`, `subscribe()`), boot watchdog, multi-boot probation, and `diagnostics()`.
- 💾 [**Storage Quotas & Cleanup (`STORAGE.md`)**](STORAGE.md) — Cache storage quotas, persistent storage permissions, and on-demand LRU runtime cache cleanup.
- 📱 [**PWA Installation Manager (`INSTALLER.md`)**](INSTALLER.md) — Capturing `beforeinstallprompt`, detecting standalone display mode, and programmatic installation prompts.

---

## Quick Integration

### Drop-in Script (No Bundler)

```html
<!-- In index.html before closing </body> -->
<script src="/client.js"></script>
<script>
  NLPWAClient.register('/sw.js', {
    onUpdateReady: ({ version }) => {
      document.getElementById('update-banner').hidden = false;
    },
  });
</script>

<div id="update-banner" hidden>
  <span>A new version is ready!</span>
  <button onclick="NLPWAClient.applyUpdate()">Update Now</button>
</div>
```

### ES Module / Bundler (Vite, Rollup, Webpack)

```javascript
import { register, applyUpdate, onStagingProgress } from 'nlpwa/client';

register('/sw.js', {
  autoReload: false,
  reloadOnUpdateApplied: true,
  onUpdateReady: ({ version }) => {
    console.log(`Update ${version} staged and ready!`);
  },
});
```

---

## Unified Singleton: `nlpwa` / `client`

For modern ergonomic development, you can import the unified singleton instance:

```javascript
import { nlpwa } from 'nlpwa/client';

// Access all client capabilities from one namespace:
await nlpwa.register('/sw.js');
const status = await nlpwa.getStatus();
const state = nlpwa.getState();
```
