// The app's main flows, against Sayso offline (simulated Airwallex and Metal, seeded with
// sample invoices and two agent payouts). Exact steps only, so no model is needed to run them.
import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Screen = Parameters<Parameters<typeof test>[1]>[0]['screen'];

async function signIn(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('sayso-demo');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
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
  await expect(screen.getByRole('button', 'Talk')).not.toBeVisible();
});

test('pressing Enter in the token field signs in', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('sayso-demo');
  await browser.locator('#token').press('Enter');
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
});

test('opening a decision from Home focuses that exact payment and keeps it on screen', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  // Short, so the later rows start below the fold.
  await browser.setViewport({ width: 1280, height: 600 });
  const last = browser.locator('ol.dp-list li:last-child button');
  const listed = await browser.locator('ol.dp-list li:last-child .dp-who b').textContent();
  const latest = (await browser.locator('.dp-what').textContent())!.split(' to ').slice(1).join(' to ');
  // After opening, what has focus must be that payment's own row head, open, and fully inside the viewport.
  const focused = () => browser.evaluate(async () => {
    // Let any scroll that starts late (smooth, to the top) land first, then give the focused head up to 3 s to be fully in view.
    await new Promise((r) => setTimeout(r, 500));
    const inView = () => { const r = document.activeElement?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; };
    for (const end = Date.now() + 3000; !inView() && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    const row = document.activeElement?.closest('.row');
    return {
      head: document.activeElement?.classList.contains('row-head') ?? false,
      open: row?.classList.contains('open') ?? false,
      who: row?.querySelector('.rh-who')?.textContent ?? null,
      visible: inView(),
    };
  });
  await last.click();
  expect(await focused()).toEqual({ head: true, open: true, who: listed, visible: true });
  await browser.locator('button.tab').first().click(); // back to Home
  await browser.locator('.dp-latest').click();
  expect(await focused()).toEqual({ head: true, open: true, who: latest, visible: true });
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

// Needs Hugging Face for the ~79 MB model the first time; E2E_OFFLINE=1 skips it.
test('saying a payment by voice goes through Whisper on this device', { timeout: 280_000, skip: process.env.E2E_OFFLINE === '1' && 'needs Hugging Face' }, async ({ app, screen, browser }) => {
  // The mic is a recorded voice: played once, then the stream stays live on silence so the app's own silence stop ends it.
  const wav = readFileSync('tests/fixtures/say-pay-kreuzberg.wav');
  await browser.addInitScript((b64: string) => {
    try { localStorage.setItem('sayso.voice', 'whisper'); } catch {}
    // The app only picks Whisper when it has a say-by-voice engine to prefer; remove the browser's.
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const audio = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  }, wav.toString('base64'));
  await signIn(app, screen);
  await screen.getByRole('button', 'Talk').tap();
  const live = browser.locator('#say-live');
  await expect(live).toContainText('Getting Whisper onto this device', { timeout: 20_000 });
  await expect(live).toContainText('Kreuzberg', { timeout: 180_000 });
  const card = browser.locator('.sh-card');
  // "your payment to" or "your earlier payment to", depending on whether another test already paid Kreuzberg.
  await expect(card).toContainText('IBAN ending 3000', { timeout: 30_000 });
  await expect(card).toContainText('payment to Kreuzberg Studio GmbH');
  await expect(browser.locator('.sh-card .btn.pay')).toHaveText('Pay €280.00');
});

test('a lookalike asking for new bank details is checked with a 1-cent code', async ({ app, screen, browser }) => {
  await signIn(app, screen);
  // Home's top card is the held one: tapping it opens it.
  await screen.getByRole('button', 'Held: €340.00 to Kreuzberg Studio GmbH. Opens it. Arrow keys show the next.').tap();
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
  await screen.getByRole('button', 'Held: €340.00 to Kreuzberg Studio GmbH. Opens it. Arrow keys show the next.').tap();
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
  await expect(prove).toContainText("the owner's signature and the issuer's match");
  await expect(browser.locator(`${row} .pv-proven`)).toHaveCount(6);
  await browser.locator(`${row} .prove button:has-text("Wasn't allowed")`).click();
  await expect(browser.locator(`${row} .pv-dispute`)).toContainText('Denied');
  await expect(browser.locator(`${row} .pv-dispute`)).toContainText('owner signed the mandate');
});

test('the landing board asks decide() and flips to hold when the payee name does not match', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Name mismatch').tap();
  await expect(browser.locator('.b-reason')).toContainText('Holding EUR 480.00');
  await expect(browser.locator('.dial.decider .d-val')).toHaveText('Held');
  await screen.getByRole('button', 'Paid before').tap();
  await expect(browser.locator('.b-live')).toHaveText("You're driving");
});

test('the landing checks a real receipt: its own hash matches, an edited one does not', async ({ app, browser }) => {
  await app.open('/#prove');
  // Offline, the newest receipt is a real one Sayso issued, anchored by the simulator.
  await expect(browser.locator('.receipt .r-head')).toContainText('Simulated anchor', { timeout: 20_000 });
  await expect(browser.locator('#prove .chain')).toContainText("The agent's payment on Metal");
  await browser.locator('button:has-text("Hash the receipt and compare")').click();
  await expect(browser.locator('#prove .v-line')).toContainText('Matches the hash Sayso recorded');
  await browser.locator('#r-amount').fill('9999.00');
  await browser.locator('button:has-text("Hash the receipt and compare")').click();
  await expect(browser.locator('#prove .v-line')).toContainText("Doesn't match");
});

test('a visitor can look around read-only, and nothing they do pays', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Look around, read-only').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
  await expect(browser.locator('.mode.read-only').first()).toHaveText('Read-only');
  const status = await browser.evaluate(async () => (await fetch('/v1/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'a@b.c', body: 'pay 10 EUR' }) })).status);
  expect(status).toBe(403);
});

test('the landing stays at / after signing in, and opens the app from there', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', 'Look around, read-only').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
  await app.open('/');
  await expect(browser.locator('.v-hero')).toBeVisible();
  await screen.getByRole('link', 'Open the app').first().tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
});

test('a background update keeps keyboard focus where it was', async ({ app, screen, browser }) => {
  await openEverything(app, screen);
  await screen.getByRole('tab', 'Payments').tap();
  const head = browser.locator('article.row[data-id] button.row-head').first();
  await head.focus();
  const id = await browser.evaluate(() => (document.activeElement?.closest('.row') as HTMLElement).dataset.id);
  const H = { authorization: 'Bearer sayso-demo', 'content-type': 'application/json' };
  const res = await fetch(new URL('/v1/inbox', app.baseUrl), {
    method: 'POST', headers: H,
    body: JSON.stringify({ message_id: `e2e-refocus-${Date.now()}`, from: 'Acme <billing@acme.example>', subject: `Refocus ${Date.now()}`, body: 'Please pay invoice 9 for EUR 75.00. Thanks, Acme Ltd' }),
  });
  expect(res.status).toBe(201);
  const item = (await res.json()) as { id: string };
  try {
    // Wait for the app to rebuild the page: the node that had focus is gone from the document.
    await browser.evaluate(async () => {
      const el = document.activeElement;
      for (let i = 0; i < 150 && el?.isConnected; i++) await new Promise((r) => setTimeout(r, 100));
      if (el?.isConnected) throw new Error('page was not re-rendered');
    });
    const now = await browser.evaluate(() => ({ tag: document.activeElement?.tagName ?? null, cls: document.activeElement?.className ?? null, id: (document.activeElement?.closest('.row') as HTMLElement | null)?.dataset.id ?? null }));
    expect(now).toEqual({ tag: 'BUTTON', cls: 'row-head', id });
  } finally {
    await fetch(new URL(`/v1/inbox/${encodeURIComponent(item.id)}/ignore`, app.baseUrl), { method: 'POST', headers: H, body: '{}' });
  }
});
