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
    await expect(page.locator('#conn')).toHaveText('Offline');

    // 2. Reload the page completely offline
    await page.reload();
    await expect(page.locator('#status-version')).toHaveText('v1.0.0');
    await expect(page.locator('#status-state')).toHaveText(/Offline/);

    // 3. Cache-only succeeds offline from precache
    await page.click('#strategy-tabs button[data-id="cache-only"]');
    await page.click('#test-form button[type="submit"]');
    await expect(page.locator('#viewport')).toContainText('/demo/cache-only.json');
    await expect(page.locator('#viewport')).toContainText('200');
    await expect(page.locator('#viewport')).toContainText('offline-cache');

    // 4. Restore connectivity
    await context.setOffline(false);
    await expect(page.locator('#conn')).toHaveText('Online');
  });
});
