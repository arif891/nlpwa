import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('21 - RFC 7233 Range Requests & Media Streaming (HTTP 206)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('slices cached asset into 206 Partial Content when Range header is provided', async ({ page }) => {
    const rangeData = await page.evaluate(async () => {
      const res = await fetch('/assets/css/app.css', {
        headers: { Range: 'bytes=0-9' },
      });
      const text = await res.text();
      return {
        status: res.status,
        statusText: res.statusText,
        contentRange: res.headers.get('content-range'),
        acceptRanges: res.headers.get('accept-ranges'),
        contentLength: res.headers.get('content-length'),
        length: text.length,
      };
    });

    expect(rangeData.status).toBe(206);
    expect(rangeData.statusText).toBe('Partial Content');
    expect(rangeData.contentRange).toMatch(/^bytes 0-9\/\d+$/);
    expect(rangeData.acceptRanges).toBe('bytes');
    expect(rangeData.length).toBe(10);
  });

  test('handles suffix Range (bytes=-5) returning trailing bytes', async ({ page }) => {
    const rangeData = await page.evaluate(async () => {
      const res = await fetch('/assets/css/app.css', {
        headers: { Range: 'bytes=-5' },
      });
      const text = await res.text();
      return {
        status: res.status,
        contentRange: res.headers.get('content-range'),
        length: text.length,
      };
    });

    expect(rangeData.status).toBe(206);
    expect(rangeData.length).toBe(5);
    expect(rangeData.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
  });

  test('returns 416 Range Not Satisfiable when range is beyond content boundaries', async ({ page }) => {
    const status = await page.evaluate(async () => {
      const res = await fetch('/assets/css/app.css', {
        headers: { Range: 'bytes=9999999-9999999' },
      });
      return res.status;
    });

    expect(status).toBe(416);
  });
});
