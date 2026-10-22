/**
 * Standalone Client entry (built to out/client.js, the file `nlpwa init` copies).
 *
 * Automatically registers /sw.js by default when loaded via <script src="/client.js"></script>,
 * matching the zero-boilerplate behavior of out/sw.js.
 *
 * To disable auto-registration or specify a custom Service Worker path:
 *   <script src="/client.js" data-auto-register="false"></script>
 *   <script src="/client.js" data-sw="/custom-sw.js"></script>
 *   window.NLPWA_NO_AUTO_REGISTER = true;
 */
export * from './index.js';
import { register } from './registration.js';

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

function resolveDefaultSwUrl(script) {
  const customSw = script?.getAttribute?.('data-sw');
  if (customSw) {
    return customSw;
  }
  if (script?.src && typeof window !== 'undefined' && window.location) {
    try {
      const scriptUrl = new URL(script.src, window.location.href);
      if (scriptUrl.origin === window.location.origin) {
        return new URL('sw.js', scriptUrl).pathname;
      }
    } catch {}
  }
  return '/sw.js';
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
    register(swUrl, regOptions).catch(() => {});
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', tryRegister, { once: true });
  } else {
    tryRegister();
  }
}


autoRegister();

