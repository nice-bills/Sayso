import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('back office opens', async ({ app, browser }) => {
  await app.open('/ops/');
  await expect(browser.locator('body')).toBeVisible();
});
