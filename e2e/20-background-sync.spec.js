import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('20 - Background Sync Plugin & IndexedDB Outbox', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('SyncQueue serializes requests to IndexedDB and provides full lifecycle management', async ({ page }) => {
    const queueResult = await page.evaluate(async () => {
      const { SyncQueue } = await import('/plugins/sync.client.esm.js');
      const queue = new SyncQueue('e2e-outbox');

      // Clean before test
      await queue.clear();

      // Enqueue 2 requests
      const id1 = await queue.push(new Request('/api/live/time.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', item: 'Task 1' }),
      }));

      const id2 = await queue.push(new Request('/api/live/time.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', item: 'Task 2' }),
      }));

      const all = await queue.getAll();
      const count = await queue.size();

      // Clear the queue
      await queue.clear();
      const countAfterClear = await queue.size();

      return {
        id1,
        id2,
        initialCount: count,
        url: all[0]?.url,
        method: all[0]?.method,
        countAfterClear,
      };
    });

    expect(queueResult.id1).toBeDefined();
    expect(queueResult.id2).toBeDefined();
    expect(queueResult.initialCount).toBe(2);
    expect(queueResult.url).toContain('/api/live/time.json');
    expect(queueResult.method).toBe('POST');
    expect(queueResult.countAfterClear).toBe(0);
  });

  test('SyncClient attaches event listeners and queries pending queue via messaging or IDB fallback', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { syncClient, SyncQueue } = await import('/plugins/sync.client.esm.js');
      const queue = new SyncQueue('default');

      await queue.clear();
      await queue.push(new Request('/api/live/time.json', { method: 'POST' }));

      // Query pending items via client
      const pending = await syncClient.getPending('default');

      // Test event listener subscription and unsubscription
      const unsub = syncClient.on('enqueued', () => {});
      const isUnsubFn = typeof unsub === 'function';
      unsub();

      await queue.clear();

      return {
        pendingCount: pending?.count,
        isUnsubFn,
      };
    });

    expect(result.pendingCount).toBe(1);
    expect(result.isUnsubFn).toBe(true);
  });
});
