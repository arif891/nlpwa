import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('09 - Multi-Tab Consensus & Leader Election', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('elects exactly one leader and transfers leadership when leader tab closes', async ({ context, page }) => {
    // 1. Tab 1 should be leader
    await page.waitForFunction(() => window.NLPWAClient.nlpwa.isLeader() === true);
    const isLeader1 = await page.evaluate(() => window.NLPWAClient.nlpwa.isLeader());
    expect(isLeader1).toBe(true);

    // 2. Open Tab 2 in the same browser context
    const page2 = await context.newPage();
    await page2.goto('/');
    await waitForActiveSW(page2);

    // Allow leader heartbeat / election cycle to settle
    await page2.waitForTimeout(300);

    // Tab 2 must NOT be leader while Tab 1 is open
    const isLeader2 = await page2.evaluate(() => window.NLPWAClient.nlpwa.isLeader());
    expect(isLeader2).toBe(false);

    // 3. Close Tab 1
    await page.close();

    // 4. Tab 2 should automatically become the new leader
    await page2.waitForFunction(() => window.NLPWAClient.nlpwa.isLeader() === true, null, { timeout: 5000 });
    const isLeader2After = await page2.evaluate(() => window.NLPWAClient.nlpwa.isLeader());
    expect(isLeader2After).toBe(true);

    await page2.close();
  });
});
