import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('10 - Cache Quotas & Runtime Cleanup', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('getCacheInfo retrieves storage metrics and cleanupRuntimeCache evicts entries', async ({ page }) => {
    // 1. Populate runtime cache with multiple requests
    await page.click('#btnTestFeed');
    await page.waitForTimeout(100);
    await page.click('#btnTestProfile');
    await page.waitForTimeout(100);

    // 2. Query cache info
    const cacheInfo = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getCacheInfo();
    });

    expect(cacheInfo).toBeTruthy();
    expect(typeof cacheInfo.runtimeEntries).toBe('number');
    expect(cacheInfo.runtimeEntries).toBeGreaterThanOrEqual(1);

    // 3. Trigger on-demand cleanup enforcing maxEntries: 1
    const cleanupResult = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.cleanupRuntimeCache({ maxEntries: 1 });
    });

    expect(cleanupResult).toBeTruthy();
    expect(cleanupResult.success).toBe(true);

    // 4. Verify post-cleanup runtime cache entries <= 1
    const cacheInfoAfter = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getCacheInfo();
    });

    expect(cacheInfoAfter.runtimeEntries).toBeLessThanOrEqual(1);
  });
});
