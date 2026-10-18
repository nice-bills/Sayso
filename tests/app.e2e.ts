// The app's main flows, against Sayso offline (simulated Airwallex and Metal, seeded with
// sample invoices and two agent payouts). Exact steps only, so no model is needed to run them.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Screen = Parameters<Parameters<typeof test>[1]>[0]['screen'];

async function signIn(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('sayso-demo');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('heading', 'Needs you')).toBeVisible();
}

test('a wrong token does not get in', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('not-the-token');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('alert')).toContainText("That token isn't right.");
  await expect(screen.getByRole('heading', 'Needs you')).not.toBeVisible();
});

test('one tap pays a forwarded invoice', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  await screen.getByRole('button', 'Pay £72.00').tap();
  const card = browser.locator('article.inv:has-text("Holloway Print Ltd")');
  await expect(card).toContainText('Sent by Airwallex', { timeout: 10_000 });
  await expect(browser.locator('article.inv:has-text("Holloway Print Ltd") .pill')).toHaveText('Delivered', { timeout: 20_000 });
});

test('a bank-details change waits for a confirmed phone call', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  const pay = screen.getByRole('button', 'Pay €60.00');
  await expect(pay).toBeDisabled();
  await screen.getByRole('checkbox', 'I confirmed these bank details with the payee myself.').tap();
  await expect(pay).toBeEnabled();
  await pay.tap();
  await expect(browser.locator('article.inv:has-text("Berlin Office Lettings")')).toContainText('Sent by Airwallex', { timeout: 10_000 });
});

test('missing details can be filled in, then it is ready to pay', async ({ app, screen }) => {
  await signIn(app, screen);
  await screen.getByRole('button', 'Add missing details').tap();
  await screen.getByLabel('Payee name').fill('Kreuzberg Studio GmbH');
  await screen.getByLabel('Amount').fill('120.00');
  await screen.getByLabel('Currency').fill('EUR');
  await screen.getByLabel('IBAN (or an account number below)').fill('DE89370400440532013000');
  await screen.getByLabel('Bank country (2 letters)').fill('DE');
  await screen.getByRole('button', 'Save and check').tap();
  await expect(screen.getByRole('button', 'Pay €120.00')).toBeVisible();
});

test('connecting an agent shows its key once, and agent payouts are listed', async ({ app, screen }) => {
  await signIn(app, screen);
  await screen.getByRole('tab', 'Agents').tap();
  await screen.getByLabel('Agent name').fill('My phone assistant');
  await screen.getByRole('button', 'Create a key').tap();
  await expect(screen.getByRole('button', 'Copy key')).toBeVisible();
  await screen.getByRole('button', 'Done').tap();
  await expect(screen.getByText('My phone assistant')).toBeVisible();
  await expect(screen.getByText('Lingua Freelance')).toBeVisible();
  await expect(screen.getByText('Rechenzentrum Nord GmbH')).toBeVisible();
});
