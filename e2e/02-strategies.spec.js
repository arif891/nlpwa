import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('02 - Caching Strategies & X-Cache-Status', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('cache-first: serves from cache with instant response', async ({ page }) => {
    await page.click('#strategy-tabs button[data-id="cache-first"]');
    // First request populates cache
    await page.click('#test-form button[type="submit"]');
    await page.waitForTimeout(150);

    // Second request serves from cache
    await page.click('#test-form button[type="submit"]');

    await expect(page.locator('#viewport')).toContainText('/demo/cache-first.json');
    await expect(page.locator('#viewport')).toContainText(/runtime-cache|offline-cache/);
  });

  test('network-only: bypasses cache entirely and tags status', async ({ page }) => {
    await page.click('#strategy-tabs button[data-id="network-only"]');
    await page.click('#test-form button[type="submit"]');

    await expect(page.locator('#viewport')).toContainText('/demo/network-only.json');
    await expect(page.locator('#viewport')).toContainText('200 network');
  });

  test('stale-while-revalidate: returns cached content and revalidates', async ({ page }) => {
    await page.click('#strategy-tabs button[data-id="swr"]');
    // First request populates runtime cache
    await page.click('#test-form button[type="submit"]');
    await page.waitForTimeout(200);

    // Second request should serve from cache
    await page.click('#test-form button[type="submit"]');
    await expect(page.locator('#viewport')).toContainText(/stale|runtime-cache/);
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
