import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('25 - Showcase Tabs & Responsive Mobile Navigation', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('desktop view (1000px): header links switch active tab and inert state', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });

    // 1. Initial tab is Playground
    const playgroundLink = page.locator('.links-wrapper a[href="#playground"]');
    await expect(playgroundLink).toHaveClass(/active/);
    await expect(playgroundLink).toBeVisible();

    const installBtn = page.locator('.install');
    await expect(installBtn).toBeVisible();

    // 2. Click Updates tab
    await page.click('.links-wrapper a[href="#updates"]');
    await expect(page.locator('.links-wrapper a[href="#updates"]')).toHaveClass(/active/);
    await expect(page.locator('#updates')).not.toHaveAttribute('inert');
    await expect(page.locator('#playground')).toHaveAttribute('inert');

    // 3. Click Storage tab
    await page.click('.links-wrapper a[href="#storage"]');
    await expect(page.locator('.links-wrapper a[href="#storage"]')).toHaveClass(/active/);
    await expect(page.locator('#storage')).not.toHaveAttribute('inert');

    // 4. Click Plugins tab
    await page.click('.links-wrapper a[href="#plugins"]');
    await expect(page.locator('.links-wrapper a[href="#plugins"]')).toHaveClass(/active/);
    await expect(page.locator('#plugins')).not.toHaveAttribute('inert');
  });

  test('mobile view (<800px): header links hidden, install button visible, floating bottom switcher active', async ({ page }) => {
    // Set to mobile portrait (500x800)
    await page.setViewportSize({ width: 500, height: 800 });

    // 1. Desktop link buttons should be hidden via CSS media query
    const headerLinks = page.locator('.links-wrapper');
    await expect(headerLinks).not.toBeVisible();

    // 2. Install app button must REMAIN visible
    const installBtn = page.locator('.install');
    await expect(installBtn).toBeVisible();

    // 3. Floating bottom tab bar must be visible
    const floatingTabs = page.locator('.floating-tabs');
    await expect(floatingTabs).toBeVisible();

    // 4. Clicking floating icons navigates between tabs
    const updatesTabIcon = page.locator('.floating-tabs a[href="#updates"]');
    await updatesTabIcon.click();
    await expect(updatesTabIcon).toHaveClass(/active/);
    await expect(page.locator('#updates')).not.toHaveAttribute('inert');

    const pluginsTabIcon = page.locator('.floating-tabs a[href="#plugins"]');
    await pluginsTabIcon.click();
    await expect(pluginsTabIcon).toHaveClass(/active/);
    await expect(page.locator('#plugins')).not.toHaveAttribute('inert');
  });
});
