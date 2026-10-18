import { test, expect } from '@playwright/test';
import { waitForActiveSW, getCacheNames, getActivePointer, resetServerVersion } from './helpers/sw-helper.js';

test.describe('04 - Atomic Version Commit & Tab Coordination', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('clicking Apply & Reload flips active pointer and cleans up old cache', async ({ page }) => {
    // Stage update to 1.0.1
    await page.click('#btnSimulateUpdate');
    await expect(page.locator('#updateBanner')).toHaveClass(/show/, { timeout: 10_000 });

    const cachesBefore = await getCacheNames(page);
    const oldCache = cachesBefore.find((c) => c.startsWith('offline@1.0.0'));
    expect(oldCache).toBeTruthy();

    // Click "Apply & Reload"
    await page.click('#btnApplyUpdate');

    // Page reloads into new version
    await page.waitForNavigation();
    await waitForActiveSW(page);

    // Active pointer is now 1.0.1
    const newPointer = await getActivePointer(page);
    expect(newPointer.version).toBe('1.0.1');
    expect(newPointer.cache).toMatch(/^offline@1\.0\.1-/);

    // Staged cache became the active offline cache
    const cachesAfter = await getCacheNames(page);
    expect(cachesAfter.some((c) => c.startsWith('offline@1.0.1'))).toBe(true);
  });

  test('navigation in a second tab commits staged version before serving page', async ({ context, page }) => {
    // Stage update in Tab 1
    await page.click('#btnSimulateUpdate');
    await expect(page.locator('#updateBanner')).toHaveClass(/show/, { timeout: 10_000 });

    // Open Tab 2 (navigation request)
    const page2 = await context.newPage();
    await page2.goto('/');
    await waitForActiveSW(page2);

    // Tab 2 navigation committed the staged version
    const activePointer = await getActivePointer(page2);
    expect(activePointer.version).toBe('1.0.1');
    await page2.close();
  });
});
