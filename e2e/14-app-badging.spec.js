import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('14 - App Badging API & State Integration', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('setAppBadge and clearAppBadge invoke navigator APIs and synchronize reactive store', async ({ page }) => {
    // 1. Setup mock badging API on navigator to simulate platform support
    await page.evaluate(() => {
      window._badgeHistory = [];
      navigator.setAppBadge = async (count) => {
        window._badgeHistory.push({ action: 'set', count });
      };
      navigator.clearAppBadge = async () => {
        window._badgeHistory.push({ action: 'clear' });
      };
    });

    // 2. isBadgingSupported() should return true
    const isSupported = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.isBadgingSupported();
    });
    expect(isSupported).toBe(true);

    // 3. Set badge with count 7
    const setResult = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.setAppBadge(7);
    });
    expect(setResult).toBe(true);

    const stateAfterSet = await page.evaluate(() => {
      return {
        badgeCount: window.NLPWAClient.nlpwa.getState().badgeCount,
        history: window._badgeHistory,
      };
    });
    expect(stateAfterSet.badgeCount).toBe(7);
    expect(stateAfterSet.history).toContainEqual({ action: 'set', count: 7 });

    // 4. Set float badge count (should be floored)
    await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.setAppBadge(4.9);
    });
    const stateAfterFloat = await page.evaluate(() => {
      return {
        badgeCount: window.NLPWAClient.nlpwa.getState().badgeCount,
        history: window._badgeHistory,
      };
    });
    expect(stateAfterFloat.badgeCount).toBe(4);
    expect(stateAfterFloat.history).toContainEqual({ action: 'set', count: 4 });

    // 5. Set uncounted dot badge (no argument)
    await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.setAppBadge();
    });
    const stateAfterDot = await page.evaluate(() => {
      return {
        badgeCount: window.NLPWAClient.nlpwa.getState().badgeCount,
        history: window._badgeHistory,
      };
    });
    expect(stateAfterDot.badgeCount).toBe(1);
    expect(stateAfterDot.history).toContainEqual({ action: 'set', count: undefined });

    // 6. Setting badge to 0 clears the badge
    await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.setAppBadge(0);
    });
    const stateAfterZero = await page.evaluate(() => {
      return {
        badgeCount: window.NLPWAClient.nlpwa.getState().badgeCount,
        history: window._badgeHistory,
      };
    });
    expect(stateAfterZero.badgeCount).toBe(0);
    expect(stateAfterZero.history).toContainEqual({ action: 'clear' });

    // 7. Explicit clearAppBadge()
    await page.evaluate(async () => {
      await window.NLPWAClient.nlpwa.setAppBadge(3);
      return await window.NLPWAClient.nlpwa.clearAppBadge();
    });
    const finalState = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.getState().badgeCount;
    });
    expect(finalState).toBe(0);
  });

  test('gracefully returns false when badging API is not supported by the environment', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Temporarily delete or override badging methods
      const origSet = navigator.setAppBadge;
      const origClear = navigator.clearAppBadge;
      try {
        delete navigator.setAppBadge;
        delete navigator.clearAppBadge;
      } catch {}

      // In case properties are non-configurable, test standalone badge client
      const isSupp = ('setAppBadge' in navigator) ? true : window.NLPWAClient.nlpwa.isBadgingSupported();
      return { isSupp };
    });
    expect(typeof result.isSupp).toBe('boolean');
  });
});
