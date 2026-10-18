import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('06 - Form Edit Protection', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('defers automatic reload when an input has focus', async ({ page }) => {
    // Add a temporary test input and focus it, registering with autoReload: true
    await page.evaluate(async () => {
      const input = document.createElement('input');
      input.id = 'testInput';
      document.body.appendChild(input);
      input.focus();

      await NLPWAClient.register('/sw.js', { autoReload: true });
    });

    // Verify isUserEditing() returns true
    const isEditing = await page.evaluate(() => {
      return typeof NLPWAClient !== 'undefined' ? NLPWAClient.isUserEditing() : false;
    });
    expect(isEditing).toBe(true);

    // Verify that onUpdatePrompt / nlpwa:update-prompt is fired instead of instant reload
    const promptDetail = await page.evaluate(async () => {
      return new Promise((resolve) => {
        document.addEventListener('nlpwa:update-prompt', (e) => resolve(e.detail), { once: true });
        // Dispatch test UPDATE_READY
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'UPDATE_READY', version: '1.0.1' },
          })
        );
        setTimeout(() => resolve(null), 1500);
      });
    });

    expect(promptDetail).toBeTruthy();
    expect(promptDetail.reason).toBe('editing');
  });
});
