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

function autoRegister() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  const tryRegister = () => {
    const script = document.currentScript || document.querySelector?.('script[src*="client.js"]');
    if (script && (script.getAttribute('data-auto-register') === 'false' || script.hasAttribute('data-no-auto-register'))) {
      return;
    }
    if (window.NLPWA_NO_AUTO_REGISTER === true) {
      return;
    }
    const swUrl = script?.getAttribute('data-sw') || '/sw.js';
    register(swUrl).catch(() => {});
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', tryRegister, { once: true });
  } else {
    tryRegister();
  }
}

autoRegister();
