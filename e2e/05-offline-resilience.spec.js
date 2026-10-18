import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('05 - Offline Operation & Network Fallbacks', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('serves precached application shell and offline data while offline', async ({ context, page }) => {
    // 1. Simulate offline state via Chromium Network emulation
    await context.setOffline(true);
    await expect(page.locator('#connectionLabel')).toHaveText('Offline');

    // 2. Reload the page completely offline
    await page.reload();
    await expect(page.locator('.brand-title')).toHaveText('NLPWA Engine');

    // 3. Cache-only and offline-data succeed offline
    await page.click('#btnTestOffline');
    await expect(page.locator('#inspectStatus')).toContainText('200');
    await expect(page.locator('#inspectCacheStatus')).toHaveText('offline-cache');

    // 4. Restore connectivity
    await context.setOffline(false);
    await expect(page.locator('#connectionLabel')).toHaveText('Online');
  });
});
