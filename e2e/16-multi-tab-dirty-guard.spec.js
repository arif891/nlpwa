import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('16 - Multi-Tab Dirty Guard & Consensus', () => {
  test.beforeEach(async ({ context, request }) => {
    await resetServerVersion(request);
  });

  test('tab queries other open tabs and detects unsaved edits before reloading', async ({ context }) => {
    const page1 = await context.newPage();
    await page1.goto('/');
    await waitForActiveSW(page1);

    const page2 = await context.newPage();
    await page2.goto('/');
    await waitForActiveSW(page2);

    // 1. Initially neither tab is dirty
    const initialCheck = await page2.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.checkDirtyTabs();
    });
    expect(initialCheck.hasDirtyTabs).toBe(false);
    expect(initialCheck.canReload).toBe(true);

    // 2. Mark page1 as dirty via setDirty(true)
    await page1.evaluate(() => {
      window.NLPWAClient.nlpwa.setDirty(true);
    });

    // 3. page2 checks dirty tabs across the consensus bus
    const dirtyCheck = await page2.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.checkDirtyTabs(300);
    });
    expect(dirtyCheck.hasDirtyTabs).toBe(true);
    expect(dirtyCheck.canReload).toBe(false);
    expect(dirtyCheck.dirtyTabs.length).toBeGreaterThanOrEqual(1);

    // 4. Register custom dirty guard in page1 and unset manual dirty
    await page1.evaluate(() => {
      window.NLPWAClient.nlpwa.setDirty(false);
      window._guardActive = true;
      window.NLPWAClient.nlpwa.registerDirtyGuard(() => window._guardActive);
    });

    const guardCheck = await page2.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.checkDirtyTabs(300);
    });
    expect(guardCheck.hasDirtyTabs).toBe(true);
    expect(guardCheck.canReload).toBe(false);

    // 5. Deactivate guard in page1
    await page1.evaluate(() => {
      window._guardActive = false;
    });

    const cleanCheck = await page2.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.checkDirtyTabs(300);
    });
    expect(cleanCheck.hasDirtyTabs).toBe(false);
    expect(cleanCheck.canReload).toBe(true);

    await page1.close();
    await page2.close();
  });
});
