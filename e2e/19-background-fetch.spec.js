import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('19 - Background Fetch API & Client Plugin', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('isBackgroundFetchSupported accurately reflects environment capabilities', async ({ page }) => {
    const isSupported = await page.evaluate(async () => {
      const { isBackgroundFetchSupported } = await import('/plugins/bg-fetch.client.esm.js');
      return isBackgroundFetchSupported();
    });
    expect(typeof isSupported).toBe('boolean');
  });

  test('backgroundFetchClient registers event handlers and cleans up listeners', async ({ page }) => {
    const unsubscribesWork = await page.evaluate(async () => {
      const { backgroundFetchClient } = await import('/plugins/bg-fetch.client.esm.js');
      const unsubSuccess = backgroundFetchClient.onSuccess(() => {});
      const unsubFail = backgroundFetchClient.onFail(() => {});
      const unsubAbort = backgroundFetchClient.onAbort(() => {});

      const allFunctions = (
        typeof unsubSuccess === 'function' &&
        typeof unsubFail === 'function' &&
        typeof unsubAbort === 'function'
      );

      unsubSuccess();
      unsubFail();
      unsubAbort();

      return allFunctions;
    });

    expect(unsubscribesWork).toBe(true);
  });

  test('fetch throws clear error when Background Fetch API is unsupported', async ({ page }) => {
    const throwsExpected = await page.evaluate(async () => {
      const { BackgroundFetchClient } = await import('/plugins/bg-fetch.client.esm.js');
      const testClient = new BackgroundFetchClient();

      // Simulate environment where registration lacks backgroundFetch
      testClient.getRegistration = async () => ({ backgroundFetch: null });

      try {
        await testClient.fetch('test-fetch-1', ['/assets/theme.json']);
        return false;
      } catch (err) {
        return err.message.includes('Background Fetch API is not supported');
      }
    });

    expect(throwsExpected).toBe(true);
  });

  test('fetch coordinates with mock BackgroundFetchManager to track progress', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { backgroundFetchClient } = await import('/plugins/bg-fetch.client.esm.js');
      const reg = await navigator.serviceWorker.ready;

      // Mock BackgroundFetchRegistration
      const mockFetchRegistration = {
        id: 'bg-asset-dl-01',
        downloaded: 1024,
        downloadTotal: 2048,
        uploaded: 0,
        uploadTotal: 0,
        result: '',
        failureReason: '',
        recordsAvailable: true,
        addEventListener: (event, handler) => {
          if (event === 'progress') {
            setTimeout(() => {
              mockFetchRegistration.downloaded = 2048;
              handler();
            }, 50);
          }
        },
        removeEventListener: () => {},
        match: async () => null,
        matchAll: async () => [],
        abort: async () => true,
      };

      // Install mock backgroundFetch on active registration
      reg.backgroundFetch = {
        fetch: async (id, requests, options) => {
          mockFetchRegistration.id = id;
          mockFetchRegistration.downloadTotal = options?.downloadTotal || 2048;
          return mockFetchRegistration;
        },
        get: async (id) => mockFetchRegistration,
        getIds: async () => ['bg-asset-dl-01'],
      };

      const progressEvents = [];
      const fetchReg = await backgroundFetchClient.fetch('bg-asset-dl-01', ['/assets/theme.json'], {
        downloadTotal: 2048,
        onProgress: (p) => {
          progressEvents.push(p);
        },
      });

      // Wait a moment for progress callback to trigger
      await new Promise(r => setTimeout(r, 100));

      const retrievedIds = await backgroundFetchClient.getIds();
      const retrievedReg = await backgroundFetchClient.get('bg-asset-dl-01');

      return {
        fetchRegId: fetchReg.id,
        retrievedIds,
        retrievedRegId: retrievedReg.id,
        progressCount: progressEvents.length,
      };
    });

    expect(result.fetchRegId).toBe('bg-asset-dl-01');
    expect(result.retrievedIds).toContain('bg-asset-dl-01');
    expect(result.retrievedRegId).toBe('bg-asset-dl-01');
    expect(result.progressCount).toBeGreaterThanOrEqual(1);
  });
});
