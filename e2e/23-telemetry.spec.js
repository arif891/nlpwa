import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('23 - Client Telemetry Reporting', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('sendTelemetryReport is a no-op when telemetry is not enabled', async ({ page }) => {
    const sent = await page.evaluate(async () => {
      window.NLPWAClient.configureTelemetry(false);
      return await window.NLPWAClient.sendTelemetryReport('boot_failure', { detail: 'none' });
    });
    expect(sent).toBe(false);
  });

  test('sendTelemetryReport dispatches payload when enabled', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const dispatched = [];
      // Intercept navigator.sendBeacon
      navigator.sendBeacon = (url, body) => {
        dispatched.push({ url, body: JSON.parse(body) });
        return true;
      };

      window.NLPWAClient.configureTelemetry({ url: '/api/telemetry-test' });
      const sent = await window.NLPWAClient.sendTelemetryReport('storage_warning', {
        usageMB: 450,
      });

      return {
        sent,
        dispatched,
      };
    });

    expect(result.sent).toBe(true);
    expect(result.dispatched.length).toBe(1);
    expect(result.dispatched[0].url).toBe('/api/telemetry-test');
    expect(result.dispatched[0].body.event).toBe('storage_warning');
    expect(result.dispatched[0].body.usageMB).toBe(450);
  });
});
