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

    // 2. Inject script tag with data-dev="true"
    await page.evaluate(async () => {
      const script = document.createElement('script');
      script.src = '/assets/js/client.js';
      script.setAttribute('data-dev', 'true');
      document.head.appendChild(script);
    });

    // 3. Give client a moment to evaluate and enforce
    await page.waitForTimeout(500);

    const hasWorker = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });
    expect(hasWorker).toBe(false);
  });

  test('dev: true in nlpwa.config.js triggers dev mode unregister', async ({ page }) => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const configPath = resolve('example/nlpwa.config.js');
    const originalContent = readFileSync(configPath, 'utf8');

    try {
      // 1. Ensure SW is active initially
      await page.goto('/');
      await waitForActiveSW(page);

      // 2. Add dev: true to example/nlpwa.config.js
      writeFileSync(configPath, originalContent.replace('export default {', 'export default {\n  dev: true,'), 'utf8');

      // 3. Reload page with the dev: true config
      await page.goto('/');

      // 4. Client must have fetched config.json, detected dev: true, and unregistered SW
      await expect.poll(async () => {
        return await page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return !reg;
        });
      }, { timeout: 4000 }).toBe(true);
    } finally {
      writeFileSync(configPath, originalContent, 'utf8');
    }
  });

  test('window.NLPWA_CONFIG = { dev: true } triggers dev mode unregister', async ({ page }) => {
    await page.goto('/');
    await waitForActiveSW(page);

    await page.addInitScript(() => {
      window.NLPWA_CONFIG = { dev: true };
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    const hasReg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
    expect(hasReg).toBe(false);
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
});
