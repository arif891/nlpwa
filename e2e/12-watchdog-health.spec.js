import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('12 - Boot Health & Probation Reporting', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('markHealthy reports success to SW without errors', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        await window.NLPWAClient.nlpwa.markHealthy('1.0.0');
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    expect(result.success).toBe(true);
  });

  test('reportBootFailure dispatches event and reports failure safely', async ({ page }) => {
    const failureEventFired = await page.evaluate(async () => {
      return new Promise((resolve) => {
        document.addEventListener('nlpwa:boot-failure', (e) => {
          resolve(e.detail);
        }, { once: true });

        // Report test failure with rollback: false so SW doesn't roll back the dev server
        window.NLPWAClient.nlpwa.reportBootFailure(new Error('Synthetic e2e startup error'), { rollback: false });
        setTimeout(() => resolve(null), 1000);
      });
    });

    expect(failureEventFired).toBeTruthy();
    expect(failureEventFired.error).toContain('Synthetic e2e startup error');
  });
});
