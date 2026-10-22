# Client SDK — PWA Installation Manager

Provides a complete manager for handling native browser install prompts (`beforeinstallprompt`), detecting standalone display mode, and controlling custom install buttons.

---

## API Reference

```javascript
import { nlpwa } from 'nlpwa/client';
```

### `nlpwa.canInstall()`
Returns `true` if the browser has fired `beforeinstallprompt` and the app is ready to prompt for installation.

### `nlpwa.isInstalled()`
Returns `true` if the app is currently running in standalone display mode (e.g. `display-mode: standalone` or `navigator.standalone`).

### `nlpwa.promptInstall()`
Presents the native browser installation prompt to the user:

```javascript
const installButton = document.getElementById('install-btn');

installButton.addEventListener('click', async () => {
  const outcome = await nlpwa.promptInstall();
  console.log('User response:', outcome); // 'accepted' | 'dismissed'
});
```

### Event Listeners

```javascript
// Fired when the app becomes eligible for installation
nlpwa.onInstallPrompt(() => {
  installButton.hidden = false;
});

// Fired when the user completes installation
nlpwa.onInstalled(() => {
  installButton.hidden = true;
  showWelcomeToast('App successfully installed!');
});
```
