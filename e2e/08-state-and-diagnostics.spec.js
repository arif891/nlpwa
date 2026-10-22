import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('08 - Reactive State Store & Diagnostics API', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('getState returns complete state snapshot matching active SW version', async ({ page }) => {
    const state = await page.evaluate(() => {
      return window.NLPWAClient.nlpwa.getState();
    });

    expect(state).toBeTruthy();
    expect(state.online).toBe(true);
    expect(state.updateStatus).toBe('idle');
    expect(state.version).toBe('1.0.0');
    expect(state.activeVersion).toBe('1.0.0');
    expect(state.stagedVersion).toBeNull();
    expect(typeof state.isInstallable).toBe('boolean');
    expect(typeof state.isInstalled).toBe('boolean');
  });

  test('subscribe receives state change notifications when going offline and online', async ({ context, page }) => {
    // Register subscription in browser
    await page.evaluate(() => {
      window._stateHistory = [];
      window._unsub = window.NLPWAClient.nlpwa.subscribe((state) => {
        window._stateHistory.push({ online: state.online, status: state.updateStatus });
      });
    });

    // 1. Toggle offline
    await context.setOffline(true);
    await page.waitForTimeout(100);

    // 2. Toggle back online
    await context.setOffline(false);
    await page.waitForTimeout(100);

    const history = await page.evaluate(() => {
      window._unsub?.();
      return window._stateHistory;
    });

    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((s) => s.online === false)).toBe(true);
    expect(history[history.length - 1].online).toBe(true);
  });

  test('getDiagnostics returns detailed runtime and storage diagnostics', async ({ page }) => {
    const diag = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.getDiagnostics();
    });

    expect(diag).toBeTruthy();
    expect(diag.active).toBeTruthy();
    expect(diag.active.version).toBe('1.0.0');
    expect(diag.active.cache).toMatch(/^offline@1\.0\.0-/);
    expect(diag.pinStatus).toBeTruthy();
    expect(diag.pinStatus.state).toBe('PINNED');
    expect(diag.client).toBeTruthy();
    expect(diag.client.isLeader).toBe(true);
    expect(diag.storage).toBeTruthy();
  });
});
