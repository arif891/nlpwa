# Client SDK — PWA Installation Manager

Provides a complete manager for handling native browser install prompts (`beforeinstallprompt`), detecting standalone display mode, and controlling custom install buttons.

---

## API Reference

```javascript
import { nlpwa } from 'nlpwa/client';
```

### `nlpwa.isInstallable()` (or `nlpwa.canInstall()`)
Returns `true` if the browser has fired `beforeinstallprompt` and the app is ready to prompt for installation.

### `nlpwa.isInstalled()`
Returns `true` if the app is currently running in standalone display mode (e.g. `display-mode: standalone` or `navigator.standalone`).

### `nlpwa.promptInstall()` (or `nlpwa.install()`)
Presents the native browser installation prompt to the user and resolves with the user's choice:

```javascript
const installButton = document.getElementById('install-btn');

installButton.addEventListener('click', async () => {
  const { outcome, platform } = await nlpwa.promptInstall();
  console.log('User response:', outcome); // 'accepted' | 'dismissed'
});
```

### Event Listeners

```javascript
// Fired when the app becomes eligible for installation (or installability changes)
nlpwa.onInstallable(({ isInstallable, isInstalled, prompt }) => {
  installButton.hidden = !isInstallable;
});

// Fired when the user completes installation
nlpwa.onAppInstalled((event) => {
  installButton.hidden = true;
  showWelcomeToast('App successfully installed!');
});
```

*(Convenience aliases `nlpwa.onInstallPrompt` and `nlpwa.onInstalled` are also supported).*
