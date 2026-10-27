import { test, expect } from '@playwright/test';
import { waitForActiveSW, getCacheNames, getActivePointer, resetServerVersion } from './helpers/sw-helper.js';

test.describe('03 - Over-The-Air (OTA) Delta Updates and Staging', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('detects remote version bump, stages delta in background, and shows prompt', async ({ page }) => {
    const initialPointer = await getActivePointer(page);
    expect(initialPointer.version).toBe('1.0.0');

    // 1. Switch to updates tab and simulate release bump
    await page.click('a[href="#updates"]');
    const bumpPromise = page.waitForResponse((res) => res.url().includes('/api/update/bump') || res.url().includes('/api/simulate-bump'));
    await page.locator('#btn-bump-version').click({ force: true });
    await bumpPromise;

    // 2. Client triggers update check; wait for staging and ready state
    await expect(page.locator('#ota-staged-version')).toHaveText('v1.0.1', { timeout: 10_000 });
    await expect(page.locator('#ota-status-badge')).toHaveText('READY', { timeout: 10_000 });
    await expect(page.locator('#btn-apply-update')).toHaveText('Apply v1.0.1');

    // 3. Staging occurred into an isolated staging cache
    const caches = await getCacheNames(page);
    expect(caches.some((c) => c.startsWith('offline@1.0.1'))).toBe(true);

    // 4. CRITICAL: Active pointer remains 1.0.0 while update is staged
    const currentPointer = await getActivePointer(page);
    expect(currentPointer.version).toBe('1.0.0');
    expect(currentPointer.cache).toBe(initialPointer.cache);
  });
});
