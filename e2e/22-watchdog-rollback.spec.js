import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('22 - Watchdog Rollback & Version Blacklisting', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('getBlockedVersions returns empty list initially', async ({ page }) => {
    const blocked = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getBlockedVersions();
    });
    expect(Array.isArray(blocked)).toBe(true);
    expect(blocked.length).toBe(0);
  });

  test('onRollbackApplied registers and unsubscribes event listener', async ({ page }) => {
    const unsubscribed = await page.evaluate(() => {
      const unsub = window.NLPWAClient.nlpwa.onRollbackApplied(() => {});
      const isFn = typeof unsub === 'function';
      unsub();
      return isFn;
    });
    expect(unsubscribed).toBe(true);
  });

  test('rollback handles absence of fallback version gracefully on initial version', async ({ page }) => {
    const rollbackResult = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.rollback('E2E simulated crash');
    });

    // On clean initial installation v1.0.0, there is no previous fallback version to rollback to
    expect(rollbackResult).toBeDefined();
    expect(rollbackResult.success).toBe(false);
  });
});
