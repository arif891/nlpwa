import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('11 - Release Channels', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('subscribeChannel persists channel locally and updates reactive state', async ({ page }) => {
    // 1. Initial channel should be null or default
    const initialChannel = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.getChannel();
    });

    // 2. Subscribe to beta channel
    const channelResult = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.subscribeChannel('beta');
    });
    expect(channelResult).toBe('beta');

    // 3. Verify getChannel returns 'beta'
    const currentChannel = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.getChannel();
    });
    expect(currentChannel).toBe('beta');

    // 4. Verify localStorage persistence
    const stored = await page.evaluate(() => localStorage.getItem('nlpwa_channel'));
    expect(stored).toBe('beta');

    // 5. Verify reactive state contains channel
    const state = await page.evaluate(() => window.NLPWAClient.nlpwa.getState());
    expect(state.channel).toBe('beta');

    // 6. Channel survives page reload
    await page.reload();
    await waitForActiveSW(page);

    const reloadedChannel = await page.evaluate(() => window.NLPWAClient.nlpwa.getChannel());
    expect(reloadedChannel).toBe('beta');
  });
});
