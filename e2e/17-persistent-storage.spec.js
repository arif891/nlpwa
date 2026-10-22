import { test, expect } from '@playwright/test';
import { waitForActiveSW, resetServerVersion } from './helpers/sw-helper.js';

test.describe('17 - Storage Persistence API & Reactive Store', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServerVersion(request);
    await page.goto('/');
    await waitForActiveSW(page);
  });

  test('isStoragePersistent and requestPersistentStorage interact with navigator.storage and state store', async ({ page }) => {
    // 1. Check native storage persistence status
    const initialStatus = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.isStoragePersistent();
    });
    expect(typeof initialStatus).toBe('boolean');

    // 2. Mock navigator.storage to test granted response
    await page.evaluate(() => {
      let isPersisted = false;
      window.navigator.storage.persisted = async () => isPersisted;
      window.navigator.storage.persist = async () => {
        isPersisted = true;
        return true;
      };
    });

    const isPersistedBefore = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.isStoragePersistent();
    });
    expect(isPersistedBefore).toBe(false);

    // 3. Request persistent storage
    const granted = await page.evaluate(async () => {
      return await window.NLPWAClient.nlpwa.requestPersistentStorage();
    });
    expect(granted).toBe(true);

    // 4. Verify state and isStoragePersistent() now report true
    const postState = await page.evaluate(async () => {
      return {
        persisted: await window.NLPWAClient.nlpwa.isStoragePersistent(),
        statePersistent: window.NLPWAClient.nlpwa.getState().isStoragePersistent,
      };
    });
    expect(postState.persisted).toBe(true);
    expect(postState.statePersistent).toBe(true);
  });
});
