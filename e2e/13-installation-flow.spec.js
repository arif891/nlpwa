import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('13 - PWA Installation Lifecycle', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('captures install prompt, exposes isInstallable, and resolves promptInstall', async ({ page }) => {
    // 1. Initially not installable in automated browser
    const initialInstallable = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.isInstallable();
    });
    expect(initialInstallable).toBe(false);

    // 2. Set up listener via onInstallable
    await page.evaluate(() => {
      window._installStateHistory = [];
      window.NLPWAClient.nlpwa.onInstallable((info) => {
        window._installStateHistory.push({
          isInstallable: info.isInstallable,
          isInstalled: info.isInstalled,
        });
      });
    });

    // 3. Dispatch simulated beforeinstallprompt event
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt');
      event.preventDefault = () => {};
      event.prompt = async () => {};
      event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(event);
    });

    // 4. Verify isInstallable is now true
    const isNowInstallable = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.isInstallable();
    });
    expect(isNowInstallable).toBe(true);

    // 5. Trigger promptInstall
    const promptResult = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.promptInstall();
    });

    expect(promptResult).toEqual({ outcome: 'accepted', platform: 'web' });

    // 6. After accepting, isInstalled is true and isInstallable is false
    const finalState = await page.evaluate(() => {
      return {
        isInstallable: window.NLPWAClient.nlpwa.isInstallable(),
        isInstalled: window.NLPWAClient.nlpwa.isInstalled(),
      };
    });

    expect(finalState.isInstallable).toBe(false);
    expect(finalState.isInstalled).toBe(true);
  });
});
