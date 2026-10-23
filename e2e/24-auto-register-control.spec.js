import { test, expect } from '@playwright/test';
import { resetServerVersion } from './helpers/sw-helper.js';

test.describe('24 - Auto-Registration & Custom Path Controls', () => {
  test.beforeEach(async ({ request }) => {
    await resetServerVersion(request);
  });

  test('resolveDefaultSwUrl resolves data-sw attribute or root fallback', async ({ page }) => {
    await page.goto('/');

    const urls = await page.evaluate(async () => {
      const { resolveDefaultSwUrl } = await import('/out/client.esm.js');

      // 1. Script with explicit data-sw attribute
      const scriptWithAttr = document.createElement('script');
      scriptWithAttr.setAttribute('data-sw', '/workers/custom-worker.js');
      const url1 = resolveDefaultSwUrl(scriptWithAttr);

      // 2. Script in asset subdirectory (e.g. /static/js/client.js)
      const scriptInSubdir = document.createElement('script');
      scriptInSubdir.src = window.location.origin + '/static/js/client.js';
      const url2 = resolveDefaultSwUrl(scriptInSubdir);

      // 3. Script without attributes
      const plainScript = document.createElement('script');
      const url3 = resolveDefaultSwUrl(plainScript);

      // 4. Runtime global window.NLPWA_SW_URL
      window.NLPWA_SW_URL = '/workers/global-worker.js';
      const url4 = resolveDefaultSwUrl(plainScript);
      delete window.NLPWA_SW_URL;

      return { url1, url2, url3, url4 };
    });

    expect(urls.url1).toBe('/workers/custom-worker.js');
    expect(urls.url2).toBe('/sw.js');
    expect(urls.url3).toBe('/sw.js');
    expect(urls.url4).toBe('/workers/global-worker.js');
  });

  test('window.NLPWA_NO_AUTO_REGISTER suppresses automatic service worker registration', async ({ browser }) => {
    // Create an entirely clean browser context so no prior SW registration exists
    const context = await browser.newContext();
    const page = await context.newPage();

    // Set flag before any document scripts run
    await page.addInitScript(() => {
      window.NLPWA_NO_AUTO_REGISTER = true;
    });

    await page.goto('/');

    // Wait a brief period to ensure no registration was initiated
    await page.waitForTimeout(600);

    const hasControllerOrReg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });

    // Should NOT have registered a Service Worker because auto-register was suppressed
    expect(hasControllerOrReg).toBe(false);

    await context.close();
  });
});
