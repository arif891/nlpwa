import { test, expect } from '@playwright/test';
import { waitForActiveSW, getActivePointer, resetServerVersion } from './helpers/sw-helper.js';

test.describe('07 - Client Version Pinning & Isolation', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('tab remains pinned to boot version even after new version commits in another tab', async ({ context, page }) => {
    // 1. Verify initial tab pin state on v1.0.0
    const pinInfo1 = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getPinStatus();
    });
    expect(pinInfo1).toBeTruthy();
    expect(pinInfo1.state).toBe('PINNED');
    expect(pinInfo1.version).toBe('1.0.0');

    // 2. Stage update to 1.0.1
    await page.click('#btnSimulateUpdate');
    await expect(page.locator('#updateBanner')).toHaveClass(/show/, { timeout: 10_000 });

    // 3. Open Tab 2 to commit the staged version
    const page2 = await context.newPage();
    await page2.goto('/');
    await waitForActiveSW(page2);

    // Verify Tab 2 is running v1.0.1
    const pointer2 = await getActivePointer(page2);
    expect(pointer2.version).toBe('1.0.1');

    const pinInfo2 = await page2.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getPinStatus();
    });
    expect(pinInfo2.version).toBe('1.0.1');

    // 4. CRITICAL: Tab 1 must STILL be pinned to v1.0.0 in ORPHANED (grace period) state
    const pinInfo1After = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getPinStatus();
    });
    expect(pinInfo1After.version).toBe('1.0.0');
    expect(pinInfo1After.state).toBe('ORPHANED');
    expect(pinInfo1After.graceRemainingMs).toBeGreaterThan(0);

    // 5. When Tab 1 navigates, it upgrades to v1.0.1 and becomes PINNED to new cache
    await page.reload();
    await waitForActiveSW(page);

    const pinInfo1Navigated = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getPinStatus();
    });
    expect(pinInfo1Navigated.version).toBe('1.0.1');
    expect(pinInfo1Navigated.state).toBe('PINNED');

    await page2.close();
  });
});
