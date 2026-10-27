import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('26 - Plugins Showcase Tab UI', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.addInitScript(() => {
      window._badgeHistory = [];
      navigator.setAppBadge = async (val) => { window._badgeHistory.push({ action: 'set', val }); };
      navigator.clearAppBadge = async () => { window._badgeHistory.push({ action: 'clear' }); };
      navigator.share = async (data) => {
        window._sharedData = data;
        return true;
      };
    });
    await page.goto('/');
    await waitForActiveSW(page);
    await page.click('a[href="#plugins"]');
  });

  test('app badging UI sets count and clears badge with live feedback', async ({ page }) => {
    // Click button to set badge to 5
    await page.locator('#btn-badge-5').click({ force: true });
    await expect(page.locator('#badge-status-msg')).toContainText('App badge count set to 5');

    const state5 = await page.evaluate(() => window._badgeHistory);
    expect(state5).toContainEqual({ action: 'set', val: 5 });

    // Click button to clear badge
    await page.locator('#btn-badge-clear').click({ force: true });
    await expect(page.locator('#badge-status-msg')).toContainText('App badge cleared');

    const stateClear = await page.evaluate(() => window._badgeHistory);
    expect(stateClear).toContainEqual({ action: 'clear' });
  });

  test('background sync outbox queues note and shows live feedback', async ({ page }) => {
    const noteInput = page.locator('#sync-note-input');
    await noteInput.fill('E2E Test Note from Showcase');

    await page.locator('#sync-form button[type="submit"]').click({ force: true });
    await expect(page.locator('#sync-status-msg')).toBeVisible();
    await expect(page.locator('#sync-status-msg')).toContainText(/Queued|Synced/);
  });

  test('native share trigger invokes navigator.share safely', async ({ page }) => {
    await page.locator('#btn-share-trigger').click({ force: true });
    await expect(page.locator('#native-status-msg')).toContainText(/share sheet launched|successfully/i);

    const shareData = await page.evaluate(() => window._sharedData);
    expect(shareData).toBeTruthy();
    expect(shareData.title).toContain('NLPWA');
  });
});
