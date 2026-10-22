import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('18 - Service Worker Unregistration & Re-Registration Lifecycle', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('unregisters active service worker cleanly and permits re-registration', async ({ page }) => {
    // 1. Confirm SW is currently registered
    const initialReg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(initialReg).toBe(true);

    // 2. Unregister via client API
    const unregisterSuccess = await page.evaluate(async () => {
      return await window.NLPWAClient.unregister();
    });
    expect(unregisterSuccess).toBe(true);

    // 3. Verify getRegistration returns undefined
    const postUnreg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(postUnreg).toBe(false);

    // 4. Re-register and verify it recovers
    const reregResult = await page.evaluate(async () => {
      const handle = await window.NLPWAClient.register('/sw.js');
      return !!handle.registration;
    });
    expect(reregResult).toBe(true);

    const recoveredReg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(recoveredReg).toBe(true);
  });
});
