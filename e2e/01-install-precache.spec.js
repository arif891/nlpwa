import { test, expect } from '@playwright/test';
import { waitForActiveSW, getCacheNames, getActivePointer, getActiveSnapshot, resetServerVersion } from './helpers/sw-helper.js';

test.describe('01 - Initial Install and Precaching', () => {
  test.beforeEach(async ({ context, request }) => {
    await resetServerVersion(request);
    await context.clearCookies();
  });

  test('registers SW, precaches shell, and creates nlpwa-meta pointer', async ({ page }) => {
    page.on('console', (msg) => console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[BROWSER PAGEERROR] ${err.message}`));
    await page.goto('/');

    // 1. Wait for SW to activate and control page
    await waitForActiveSW(page);
    await expect(page.locator('#swStatus')).toHaveText('Active & Controlled');

    // 2. Check CacheStorage entries
    const cacheNames = await getCacheNames(page);
    expect(cacheNames.some((name) => name.startsWith('offline@1.0.0'))).toBe(true);

    // 3. Verify active pointer in nlpwa-meta
    const pointer = await getActivePointer(page);
    expect(pointer).toBeTruthy();
    expect(pointer.version).toBe('1.0.0');
    expect(pointer.cache).toMatch(/^offline@1\.0\.0-/);

    // 4. Verify internal snapshot was written to the active cache
    const snapshot = await getActiveSnapshot(page);
    expect(snapshot).toBeTruthy();
    expect(snapshot.version).toBe('1.0.0');
    expect(Array.isArray(snapshot.files)).toBe(true);
  });

  test('subsequent initial update check downloads zero files', async ({ page }) => {
    await page.goto('/');
    await waitForActiveSW(page);

    const noUpdatePromise = page.evaluate(() => {
      return new Promise((resolve) => {
        document.addEventListener('nlpwa:no-update', (e) => resolve(e.detail), { once: true });
      });
    });

    await page.click('#btnCheckUpdate');

    const result = await noUpdatePromise;
    expect(result.version).toBe('1.0.0');
    await expect(page.locator('#updateBanner')).not.toHaveClass(/show/);
  });
});
