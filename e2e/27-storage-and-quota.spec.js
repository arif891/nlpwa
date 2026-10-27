import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('27 - Storage & Cache Quotas UI', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    page.on('console', (msg) => console.log(`[STORAGE BROWSER] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[STORAGE PAGEERROR] ${err.message}`));
    await page.goto('/');
    await waitForActiveSW(page);
    await page.click('a[href="#storage"]');
  });

  test('displays cache partitions and storage quota progress', async ({ page }) => {
    // 1. Quota progress bar and metrics
    const quotaUsage = page.locator('#storage-used-bytes');
    await expect(quotaUsage).toBeVisible();

    const quotaTotal = page.locator('#storage-total-quota');
    await expect(quotaTotal).toBeVisible();

    // 2. Partitions grid should render offline cache partition
    const partitionsGrid = page.locator('#partitions-grid');
    await expect(partitionsGrid).toBeVisible();
    await expect(partitionsGrid).toContainText(/offline@1\.0\.0/);
  });

  test('triggers LRU runtime cache cleanup and shows feedback', async ({ page }) => {
    // Populate some runtime entries first
    await page.evaluate(() => Promise.all([
      fetch('/demo/cache-first.json'),
      fetch('/demo/swr.json')
    ]));
    await page.waitForTimeout(200);

    // Click LRU cleanup button
    await page.evaluate(() => document.getElementById('btn-lru-cleanup')?.click());
    await expect(page.locator('#storage-cleanup-msg')).toContainText(/cleanup/i);
  });

  test('requests persistent storage and updates badge', async ({ page }) => {
    await page.locator('#btn-request-persist').click({ force: true });
    await expect(page.locator('#storage-persist-msg')).toBeVisible();
    await expect(page.locator('#storage-persist-badge')).toHaveText(/Persistent|Best Effort/);
  });
});
