import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('02 - Caching Strategies & X-Cache-Status', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('cache-first: serves from cache with instant response', async ({ page }) => {
    await page.click('#btnTestTheme'); // /assets/theme.json
    await expect(page.locator('#inspectEndpoint')).toHaveText('/assets/theme.json');
    await expect(page.locator('#inspectStatus')).toContainText('200');
    await expect(page.locator('#inspectCacheStatus')).toHaveText(/offline-cache|runtime-cache/);
  });

  test('network-only: bypasses cache entirely and tags status', async ({ page }) => {
    await page.click('#btnTestLive'); // /api/live/time.json
    await expect(page.locator('#inspectEndpoint')).toHaveText('/api/live/time.json');
    await expect(page.locator('#inspectCacheStatus')).toHaveText('network');
  });

  test('stale-while-revalidate: returns cached content and revalidates', async ({ page }) => {
    // First request populates runtime cache
    await page.click('#btnTestFeed');
    await page.waitForTimeout(150);

    // Second request should serve from cache
    await page.click('#btnTestFeed');
    await expect(page.locator('#inspectCacheStatus')).toHaveText(/stale|runtime-cache/);
  });

  test('atomicity rule: app shell and precached assets always serve from active offline cache', async ({ page }) => {
    const response = await page.evaluate(async () => {
      const res = await fetch('/index.html');
      return {
        status: res.status,
        cacheStatus: res.headers.get('X-Cache-Status'),
      };
    });

    expect(response.status).toBe(200);
    expect(response.cacheStatus).toBe('offline-cache');
  });
});
