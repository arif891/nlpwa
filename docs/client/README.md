# NLPWA — Client SDK & Runtime API

The NLPWA Client SDK (`client.js` or `nlpwa/client`) manages Service Worker registration, over-the-air update lifecycles, multi-tab version coherence, dirty form protection, and storage quotas.

It is available as both an ES module (`import { register } from 'nlpwa/client'`) and a pre-bundled standalone script (`/client.js`) defining `window.NLPWAClient`.

---

## Modular Documentation

The Client SDK documentation is organized into modular guides:

- 📋 [**Registration & Updates (`REGISTRATION.md`)**](REGISTRATION.md) — Service Worker initialization, development/UI design mode, update check triggers, staging progress observation, and atomic commit activation.
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
  // Optional: Listen for lifecycle events or customize callbacks
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

> **Note on Service Worker Placement & Dev Mode (`data-sw`, `data-dev`):**
> When using the drop-in `/client.js` bundle, it automatically registers `/sw.js` at the application root.
> To prevent fragile directory guessing that can accidentally restrict your Service Worker scope, specify any custom Service Worker location or scope explicitly via `data-sw` and `data-scope` (or `window.NLPWA_SW_URL` and `window.NLPWA_SW_SCOPE`):
> ```html
> <script src="/static/js/client.js" data-sw="/custom/sw.js" data-scope="/"></script>
> ```
> To enable Development / UI Design mode (unregisters SW and flushes caches for live CSS/UI editing):
> ```html
> <script src="/client.js" data-dev></script>
> ```
> To disable auto-registration entirely (e.g. if you prefer manual registration):
> ```html
> <script src="/client.js" data-auto-register="false"></script>
> ```

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
