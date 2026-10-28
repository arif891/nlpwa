import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('28 - Development / UI Design Mode Support', () => {
  test.beforeEach(async ({ request }) => {
    await resetServerVersion(request);
  });

  test('normal mode registers service worker initially', async ({ page }) => {
    await page.goto('/');
    await waitForActiveSW(page);

    const hasReg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(hasReg).toBe(true);
  });

  test('window.NLPWA_DEV = true cleanly unregisters SW and prevents auto-registration', async ({ page }) => {
    // 1. Ensure SW was registered first
    await page.goto('/');
    await waitForActiveSW(page);

    let hadRegistrationBefore = await page.evaluate(async () => {
      return !!(await navigator.serviceWorker.getRegistration());
    });
    expect(hadRegistrationBefore).toBe(true);

    // 2. Reload with window.NLPWA_DEV = true injected at init time
    await page.addInitScript(() => {
      window.NLPWA_DEV = true;
    });

    await page.goto('/');
    await page.waitForTimeout(600);

    // 3. Service worker must now be unregistered and inactive
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        hasReg: !!reg,
        count: regs.length,
        devActive: window.NLPWA_DEV_ACTIVE === true,
      };
    });

    expect(state.hasReg).toBe(false);
    expect(state.count).toBe(0);
    expect(state.devActive).toBe(true);
  });

  test('data-dev attribute on script tag suppresses registration and unregisters worker', async ({ page }) => {
    // 1. First ensure SW is running
    await page.goto('/');
    await waitForActiveSW(page);

    // 2. Set data-dev="true" on client script tag via init script so it persists across dev reload
    await page.addInitScript(() => {
      const setAttr = () => {
        const s = document.querySelector('script[src*="client"]');
        if (s && !s.hasAttribute('data-dev')) {
          s.setAttribute('data-dev', 'true');
        }
      };
      setAttr();
      const observer = new MutationObserver(setAttr);
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    });

    // 3. Reload page with data-dev attribute active on the script tag
    await page.goto('/');
    await page.waitForTimeout(600);

    const hasWorker = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });
    expect(hasWorker).toBe(false);
  });

  test('boolean data-dev attribute on script tag activates dev mode', async ({ page }) => {
    // 1. First ensure SW is running
    await page.goto('/');
    await waitForActiveSW(page);

    // 2. Set valueless boolean data-dev attribute on client script tag
    await page.addInitScript(() => {
      const setAttr = () => {
        const s = document.querySelector('script[src*="client"]');
        if (s && !s.hasAttribute('data-dev')) {
          s.setAttribute('data-dev', '');
        }
      };
      setAttr();
      const observer = new MutationObserver(setAttr);
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    });

    // 3. Reload page with boolean data-dev
    await page.goto('/');
    await page.waitForTimeout(600);

    const hasWorker = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });
    expect(hasWorker).toBe(false);
  });

  test('data-dev="false" does not activate dev mode and registers normally', async ({ page }) => {
    // 1. Set data-dev="false" on client script tag
    await page.addInitScript(() => {
      const setAttr = () => {
        const s = document.querySelector('script[src*="client"]');
        if (s && !s.hasAttribute('data-dev')) {
          s.setAttribute('data-dev', 'false');
        }
      };
      setAttr();
      const observer = new MutationObserver(setAttr);
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    });

    // 2. Load page and verify SW registers normally
    await page.goto('/');
    await waitForActiveSW(page);

    const hasReg = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(hasReg).toBe(true);
  });

  test('removing dev mode allows service worker to auto-register again', async ({ page }) => {
    // 1. Start with dev mode active
    await page.addInitScript(() => {
      window.NLPWA_DEV = true;
    });
    await page.goto('/');
    await page.waitForTimeout(400);

    let hasReg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
    expect(hasReg).toBe(false);

    // 2. Create clean page without dev mode flag
    const cleanPage = await page.context().newPage();
    await cleanPage.goto('/');
    await waitForActiveSW(cleanPage);

    hasReg = await cleanPage.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
    expect(hasReg).toBe(true);
  });

  test('URL query parameter ?nlpwa_dev=1 toggles dev mode and persists across visits on localhost', async ({ page }) => {
    // 1. Ensure SW is initially active
    await page.goto('/');
    await waitForActiveSW(page);

    // 2. Visit with ?nlpwa_dev=1
    await page.goto('/?nlpwa_dev=1');
    await page.waitForTimeout(600);

    let state = await page.evaluate(async () => ({
      hasReg: Boolean(await navigator.serviceWorker.getRegistration()),
      savedFlag: localStorage.getItem('nlpwa_dev'),
    }));
    expect(state.hasReg).toBe(false);
    expect(state.savedFlag).toBe('1');

    // 3. Later visit with no parameter and no file edits: dev mode remains active
    await page.goto('/');
    await page.waitForTimeout(400);

    state = await page.evaluate(async () => ({
      hasReg: Boolean(await navigator.serviceWorker.getRegistration()),
      savedFlag: localStorage.getItem('nlpwa_dev'),
    }));
    expect(state.hasReg).toBe(false);
    expect(state.savedFlag).toBe('1');

    // 4. Visit with ?nlpwa_dev=0: clears saved flag and re-enables normal SW registration
    await page.goto('/?nlpwa_dev=0');
    await waitForActiveSW(page);

    state = await page.evaluate(async () => ({
      hasReg: Boolean(await navigator.serviceWorker.getRegistration()),
      savedFlag: localStorage.getItem('nlpwa_dev'),
    }));
    expect(state.hasReg).toBe(true);
    expect(state.savedFlag).toBe(null);
  });
});
