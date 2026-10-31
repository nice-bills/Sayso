// The app's main flows, against Sayso offline (simulated Airwallex and Metal, seeded with
// sample invoices and two agent payouts). Exact steps only, so no model is needed to run them.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Screen = Parameters<Parameters<typeof test>[1]>[0]['screen'];

async function signIn(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('sayso-demo');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('button', 'Hold to talk')).toBeVisible();
}

/** Home is just the balance, one card and the orb; everything else is one tap away. */
async function openEverything(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await signIn(app, screen);
  await screen.getByRole('button', 'Everything').tap();
  await expect(screen.getByRole('heading', 'Inbox')).toBeVisible();
}

test('a wrong token does not get in', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('not-the-token');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('alert')).toContainText("That token isn't right.");
  await expect(screen.getByRole('button', 'Hold to talk')).not.toBeVisible();
});

test('one tap pays a forwarded invoice', async ({ app, screen, browser }) => {
  await openEverything(app, screen);
  await screen.getByRole('button', 'Pay £72.00').tap();
  const card = browser.locator('article.inv:has-text("Holloway Print Ltd")');
  await expect(card).toContainText('Sent by Airwallex', { timeout: 10_000 });
  await expect(browser.locator('article.inv:has-text("Holloway Print Ltd") .pill')).toHaveText('Delivered', { timeout: 20_000 });
});

test('a bank-details change waits for a confirmed phone call', async ({ app, screen, browser }) => {
  await openEverything(app, screen);
  const pay = screen.getByRole('button', 'Pay €60.00');
  await expect(pay).toBeDisabled();
  await screen.getByRole('checkbox', 'I confirmed these bank details with the payee myself.').tap();
  await expect(pay).toBeEnabled();
  await pay.tap();
  await expect(browser.locator('article.inv:has-text("Berlin Office Lettings")')).toContainText('Sent by Airwallex', { timeout: 10_000 });
});

test('missing details can be filled in, then it is ready to pay', async ({ app, screen }) => {
  await openEverything(app, screen);
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
  await openEverything(app, screen);
  await screen.getByRole('tab', 'Agents').tap();
  await screen.getByLabel('Agent name').fill('My phone assistant');
  await screen.getByRole('button', 'Create a key').tap();
  await expect(screen.getByRole('button', 'Copy key')).toBeVisible();
  await screen.getByRole('button', 'Done').tap();
  await expect(screen.getByText('My phone assistant')).toBeVisible();
  await expect(screen.getByText('Lingua Freelance')).toBeVisible();
  await expect(screen.getByText('Rechenzentrum Nord GmbH')).toBeVisible();
});

test('saying a payment shows what was heard and what was understood', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  await screen.getByRole('button', 'type instead').tap();
  const say = browser.locator('.say-field');
  await say.fill('Pay Kreuzberg Studio 280 euros for invoice 130');
  await say.press('Enter');
  await expect(browser.locator('#say-live')).toHaveText('“Pay Kreuzberg Studio 280 euros for invoice 130”');
  const card = browser.locator('.sh-card');
  await expect(card).toContainText('IBAN ending 3000');
  await expect(card).toContainText('from your payment to Kreuzberg Studio GmbH');
  await expect(browser.locator('.sh-card .btn.pay')).toHaveText('Pay €280.00');
});

test('a lookalike asking for new bank details is checked with a 1-cent code', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  // Home's top card is the held one: tapping it opens it.
  await screen.getByRole('button', 'Held: €340.00 to Kreuzberg Studio GmbH. Opens it.').tap();
  await screen.getByRole('button', 'Check with a 1-cent code').tap();
  const note = browser.locator('.alert.note').first();
  await expect(note).toContainText('billing@kreuzberg-studio.example');
  const link = await browser.locator('.alert.note a').first().getAttribute('href');
  await app.open(link!);
  await screen.getByRole('button', "These aren't our bank details").tap();
  await expect(browser.locator('h1')).toContainText("We won't pay those details");
});

test('the held invoice shows its decision, and one input flips it from hold to pay', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  await screen.getByRole('button', 'Held: €340.00 to Kreuzberg Studio GmbH. Opens it.').tap();
  const decision = browser.locator('.sh-card .decision');
  const verdict = browser.locator('.sh-card .decision .dc-verdict');
  await expect(verdict).toHaveText('Hold');
  await expect(decision).toContainText('Holding EUR 340.00');
  await screen.getByRole('button', 'Known bank details').tap();
  await expect(verdict).toHaveText('Pay');
  await expect(decision).toContainText('payee checks out');
  await screen.getByRole('button', 'Rate 2% dearer').tap();
  await expect(verdict).toHaveText('Wait');
  await screen.getByRole('button', 'Back to real').tap();
  await expect(verdict).toHaveText('Hold');
});

test('a payout is one line until you open it, then shows its decision', async ({ app, screen, browser }) => {
  await openEverything(app, screen);
  await screen.getByRole('tab', 'Payments').tap();
  const row = 'article.row:has-text("Lingua Freelance")';
  await expect(browser.locator(`${row} .decision`)).not.toBeVisible();
  await browser.locator(`${row} button.row-head`).click();
  await expect(browser.locator(`${row} .decision .dc-verdict`)).toHaveText('Pay');
  await expect(browser.locator(`${row} .decision`)).toContainText('Decided it');
  await browser.locator(`${row} button.row-head`).click();
  await expect(browser.locator(`${row} .decision`)).not.toBeVisible();
});

test('an agent payout proves itself, and a dispute the proof answers is denied', async ({ app, screen, browser }) => {
  await openEverything(app, screen);
  await screen.getByRole('tab', 'Payments').tap();
  const row = 'article.row:has-text("Rechenzentrum Nord")';
  await expect(browser.locator(`${row} .pill`)).toHaveText('Delivered', { timeout: 20_000 });
  await browser.locator(`${row} button.row-head`).click();
  await browser.locator(`${row} button:has-text("Prove it")`).click();
  const prove = browser.locator(`${row} .prove`);
  await expect(prove).toContainText("The owner's Metal mandate");
  await expect(prove).toContainText('signed this exact order');
  await expect(browser.locator(`${row} .pv-proven`)).toHaveCount(6);
  await browser.locator(`${row} .prove button:has-text("Wasn't allowed")`).click();
  await expect(browser.locator(`${row} .pv-dispute`)).toContainText('Denied');
  await expect(browser.locator(`${row} .pv-dispute`)).toContainText('mandate allowed this payment');
});

test('the landing board asks decide() and flips to hold when the payee name does not match', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Name mismatch').tap();
  await expect(browser.locator('.b-reason')).toContainText('Holding EUR 480.00');
  await expect(browser.locator('.dial.decider .d-val')).toHaveText('Held');
  await screen.getByRole('button', 'Paid before').tap();
  await expect(browser.locator('.b-live')).toHaveText("You're driving");
});
