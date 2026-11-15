// Layout checks: no sideways page scroll, and nothing hangs off the viewport edge.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

type Screen = Parameters<Parameters<typeof test>[1]>[0]['screen'];
type Browser = Parameters<Parameters<typeof test>[1]>[0]['browser'];

async function signIn(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await app.open('/');
  await screen.getByLabel('Owner token').fill('sayso-demo');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
}

const overflow = (browser: Browser) => browser.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('the app header fits at tablet widths', async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1024, height: 800 });
  await signIn(app, screen);
  await screen.getByRole('button', 'Everything').tap();
  const bad: string[] = [];
  for (const tab of ['Inbox', 'Payments', 'Agents']) {
    await screen.getByRole('tab', tab).tap();
    for (const width of [740, 768, 800, 1000, 1024, 1060, 1100, 1140, 1180, 1280]) {
      await browser.setViewport({ width, height: 900 });
      const over = await overflow(browser);
      // Past the viewport edge, or past the header pill that should hold it.
      const out = await browser.evaluate(() => {
        const right = document.querySelector('[aria-label="Sign out everywhere"]')!.getBoundingClientRect().right;
        return Math.max(right - innerWidth, right - document.querySelector('.top .wrap')!.getBoundingClientRect().right);
      });
      if (over > 0 || out > 0) bad.push(`${tab}@${width}: overflow ${over}, sign-out past edge by ${Math.round(out)}`);
    }
  }
  expect(bad).toEqual([]);
});

for (const width of [320, 360]) {
  test(`the held-payment sheet fits a ${width}px phone`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height: 640 });
    await signIn(app, screen);
    await browser.locator('.hc.k0').click();
    await expect(browser.locator('.osheet')).toBeVisible();
    // The chip strip bleeds into the decision box's padding on purpose, so it may pass .whatif but not .decision.
    const m = await browser.evaluate(() => {
      const over = (sel: string) => { const e = document.querySelector(sel)!; return e.scrollWidth - e.clientWidth; };
      const edge = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().right;
      return { sheet: over('.osheet'), card: over('.osheet .pcard'), decision: over('.osheet .decision'), chips: edge('.osheet .wi-chips') - edge('.osheet .decision') };
    });
    expect(Object.entries(m).filter(([, px]) => px > 0)).toEqual([]);
  });
}

test('the payment filters stay inside the page', async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 768, height: 1024 });
  await app.open('/');
  await screen.getByRole('button', 'Look around, read-only').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
  await screen.getByRole('button', 'Everything').tap();
  await screen.getByRole('tab', 'Payments').tap();
  const bad: string[] = [];
  for (const width of [740, 768, 1024, 1140, 1280, 1600]) {
    await browser.setViewport({ width, height: 1024 });
    const over = await overflow(browser);
    const right = await browser.evaluate(() => document.querySelector('.filters')!.getBoundingClientRect().right - innerWidth);
    if (over > 0 || right > 0) bad.push(`${width}: overflow ${over}, filters past edge by ${right}`);
  }
  expect(bad).toEqual([]);
});

// Controls smaller than 24x24 (WCAG 2.2 target size), as "selector WxH" strings.
const small = (browser: Browser, selector: string) => browser.evaluate((sel: string) =>
  [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect())
    .filter((r) => r.width < 24 || r.height < 24).map((r) => `${sel} ${Math.round(r.width)}x${Math.round(r.height)}`), selector);

test('the add-invoice form does not zoom iOS', async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await signIn(app, screen);
  await screen.getByRole('button', 'Everything').tap();
  await browser.locator('.add-btn').click();
  await expect(browser.locator('form.sheet textarea')).toBeVisible();
  const sizes = await browser.evaluate(() => [...document.querySelectorAll('form.sheet input:not([type=file]), form.sheet textarea')]
    .map((e) => `${(e as HTMLInputElement).name} ${getComputedStyle(e).fontSize}`).filter((s) => parseFloat(s.split(' ')[1]!) < 16));
  expect(sizes).toEqual([]);
});

test('app controls are at least 24px to tap', async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await signIn(app, screen);
  const found = await small(browser, '.sh-hint .linkish');
  await browser.locator('.sh-hint .linkish').click();
  found.push(...await small(browser, '.sh-hint .linkish'));
  await screen.getByRole('button', 'Everything').tap();
  await screen.getByRole('tab', 'Payments').tap();
  const row = 'article.row:has-text("Rechenzentrum Nord")';
  await expect(browser.locator(`${row} .pill`)).toHaveText('Delivered', { timeout: 20_000 });
  await browser.locator(`${row} button.row-head`).click();
  await browser.locator(`${row} button:has-text("Prove it")`).click();
  await expect(browser.locator(`${row} .prove`)).toBeVisible();
  found.push(...await small(browser, '.prove .wi-reset'));
  expect(found).toEqual([]);
});

test('landing controls are at least 24px to tap', async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/');
  const found = [...await small(browser, '#r-amount'), ...await small(browser, '#r-reference'), ...await small(browser, '.lp-fcol a')];
  expect(found).toEqual([]);
});

async function visitor(app: { open(path: string): Promise<unknown> }, screen: Screen) {
  await app.open('/');
  await screen.getByRole('button', 'Look around, read-only').tap();
  await expect(screen.getByRole('button', 'Talk')).toBeVisible();
}

// One test, one sign-in: the sign-in endpoint is rate limited to 20 a minute across the whole suite.
test('the visitor keeps the Read-only badge at 1024, and sees it on Home at phone widths', async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1024, height: 768 });
  await visitor(app, screen);
  const shown = (sel: string) => browser.evaluate((s: string) => (document.querySelector(s) as HTMLElement | null)?.offsetWidth ?? -1, sel);
  const bad: string[] = [];
  for (const width of [320, 360, 390, 768, 1024]) {
    await browser.setViewport({ width, height: 800 });
    const badge = await shown('.sh-mode.read-only');
    const over = await overflow(browser);
    if (badge <= 0 || over > 0) bad.push(`Home@${width}: badge ${badge}, overflow ${over}`);
  }
  await browser.setViewport({ width: 1024, height: 768 });
  await screen.getByRole('button', 'Everything').tap();
  for (const tab of ['Inbox', 'Payments', 'Agents']) {
    await screen.getByRole('tab', tab).tap();
    for (const width of [990, 1024, 1080, 1140]) {
      await browser.setViewport({ width, height: 768 });
      const badge = await shown('.top .mode.read-only');
      const over = await overflow(browser);
      if (badge <= 0 || over > 0) bad.push(`${tab}@${width}: badge ${badge}, overflow ${over}`);
    }
  }
  expect(bad).toEqual([]);
});
