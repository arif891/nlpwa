import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('15 - Web Share Target Offline Queue', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('getSharedData returns null when queue is empty', async ({ page }) => {
    const data = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getSharedData();
    });
    expect(data).toBeNull();
  });

  test('consumes pending shared payload from FIFO queue and cleans up cache entry', async ({ page }) => {
    // 1. Stage a simulated offline share in nlpwa-share-target cache
    await page.evaluate(async () => {
      const cache = await caches.open('nlpwa-share-target');
      const shareId = 'share-e2e-' + Date.now();
      const payload = {
        id: shareId,
        title: 'Project Roadmap',
        text: 'E2E testing NLPWA Share Target',
        url: 'https://example.com/roadmap',
        files: [],
        timestamp: Date.now(),
      };

      await cache.put(
        new Request('https://nlpwa.internal/_nlpwa_share/queue'),
        new Response(JSON.stringify([shareId]), { headers: { 'Content-Type': 'application/json' } })
      );
      await cache.put(
        new Request(`https://nlpwa.internal/_nlpwa_share/records/${shareId}`),
        new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
      );
    });

    // 2. Client retrieves the shared payload via getSharedData()
    const sharedData = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getSharedData();
    });

    expect(sharedData).not.toBeNull();
    expect(sharedData.title).toBe('Project Roadmap');
    expect(sharedData.text).toBe('E2E testing NLPWA Share Target');
    expect(sharedData.url).toBe('https://example.com/roadmap');

    // 3. Subsequent call returns null because FIFO queue was consumed
    const subsequentData = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getSharedData();
    });
    expect(subsequentData).toBeNull();
  });

  test('onShareTarget registers and cleans up event listener', async ({ page }) => {
    const isFunction = await page.evaluate(() => {
      const unsubscribe = window.NLPWAClient.nlpwa.onShareTarget(() => {});
      const returnsUnsub = typeof unsubscribe === 'function';
      unsubscribe();
      return returnsUnsub;
    });
    expect(isFunction).toBe(true);
  });
});
