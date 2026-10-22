/**
 * Standalone Client entry (built to out/client.js, the file `nlpwa init` copies).
 *
 * Automatically registers /sw.js (or sw.js sitting beside client.js) by default
 * when loaded via <script src="/client.js"></script>, matching zero-boilerplate behavior.
 *
 * NOTE ON PLACEMENT:
 * By default, auto-registration assumes `sw.js` sits beside `client.js` or at the application root (`/sw.js`).
 * If client.js is placed inside an asset subfolder (e.g. `/static/js/`, `/assets/`, `/dist/`), the registration
 * automatically falls back to `/sw.js` because a service worker cannot control parent scopes.
 *
 * To specify a custom Service Worker location or disable auto-registration:
 *   <script src="/static/js/client.js" data-sw="/sw.js"></script>
 *   <script src="/client.js" data-auto-register="false"></script>
 *   window.NLPWA_NO_AUTO_REGISTER = true;
 */
export * from './index.js';
import { register, resolveDefaultSwUrl } from './registration.js';
import { logger } from './logger.js';

// Synchronously capture document.currentScript at module evaluation time
const currentScript = typeof document !== 'undefined' ? document.currentScript : null;

function findClientScript() {
  if (currentScript) return currentScript;
  if (typeof document === 'undefined' || !document.querySelectorAll) return null;
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    const src = s.getAttribute('src') || '';
    if (/(?:^|\/)client(?:\.esm)?\.js(?:\?.*)?$/i.test(src.split('#')[0])) {
      return s;
    }
  }
  return null;
}

function autoRegister() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  const tryRegister = () => {
    const script = findClientScript();
    if (script) {
      const autoAttr = script.getAttribute?.('data-auto-register');
      const hasNoAuto = typeof script.hasAttribute === 'function'
        ? script.hasAttribute('data-no-auto-register')
        : Boolean(script.getAttribute?.('data-no-auto-register'));
      if (autoAttr === 'false' || hasNoAuto) {
        return;
      }
    }
    if (typeof window !== 'undefined' && window.NLPWA_NO_AUTO_REGISTER === true) {
      return;
    }
    const swUrl = resolveDefaultSwUrl(script);
    const swScope = script?.getAttribute?.('data-scope') || undefined;
    const regOptions = {
      _auto: true,
      ...(swScope ? { scope: swScope } : {}),
    };

    register(swUrl, { ...regOptions, _silentFail: swUrl !== '/sw.js' })
      .then((res) => {
        if (!res && swUrl !== '/sw.js') {
          // Derived subpath failed; fall back to root /sw.js
          return register('/sw.js', regOptions);
        }
        return res;
      })
      .then((res) => {
        if (!res) {
          logger.warn(
            `[NLPWA] Auto-registration could not find a Service Worker at '${swUrl}' or '/sw.js'. ` +
            `Ensure sw.js is located at the root or specify its location via <script src="client.js" data-sw="/path/to/sw.js"></script>.`
          );
        }
      })
      .catch((err) => {
        logger.warn(
          `[NLPWA] Auto-registration failed: ${err?.message || err}. ` +
          `Specify Service Worker path via <script src="client.js" data-sw="/path/to/sw.js"></script>.`
        );
      });
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', tryRegister, { once: true });
  } else {
    tryRegister();
  }
}

autoRegister();
