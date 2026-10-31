// Against the deployed site (APP_URL set). Read-only: nothing here moves money, so it is safe to
// run against the live Airwallex sandbox and Metal testnet. The owner signs in with a passkey there,
// so these use the landing page and the read-only visitor mode.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('live: the landing board asks the real decide() and flips to hold on a name mismatch', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Name mismatch').tap();
  await expect(browser.locator('.b-reason')).toContainText('Holding EUR 480.00', { timeout: 20_000 });
  await expect(browser.locator('.dial.decider .d-val')).toHaveText('Held');
  // The rate under the board comes from a live source, not a constant.
  const preview = await browser.evaluate(async () => (await fetch('/v1/decide/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '480.00', currency: 'EUR' }) })).json());
  expect(typeof preview.rate_source).toBe('string');
});

test('live: the newest receipt hashes to what Sayso recorded, and an edited one does not', async ({ app, browser }) => {
  await app.open('/#prove');
  await expect(browser.locator('.receipt .r-head')).toContainText(/Anchored on Metal|Simulated anchor/, { timeout: 30_000 });
  await browser.locator('button:has-text("Hash the receipt and compare")').click();
  await expect(browser.locator('#prove .v-line')).toContainText('Matches the hash Sayso recorded');
  await browser.locator('#r-amount').fill('9999.00');
  await browser.locator('button:has-text("Hash the receipt and compare")').click();
  await expect(browser.locator('#prove .v-line')).toContainText("Doesn't match");
});

test('live: a visitor can look around read-only, and cannot pay anything', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Look around, read-only').tap();
  await expect(screen.getByRole('button', 'Hold to talk')).toBeVisible({ timeout: 20_000 });
  await expect(browser.locator('.mode.read-only').first()).toHaveText('Read-only');
  const status = await browser.evaluate(async () => (await fetch('/v1/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'a@b.c', body: 'pay 10 EUR' }) })).status);
  expect(status).toBe(403);
});
