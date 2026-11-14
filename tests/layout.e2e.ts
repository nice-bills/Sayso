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
      // Payments also has the filter strip (checked in its own test), so only its header is judged here.
      if ((tab !== 'Payments' && over > 0) || out > 0) bad.push(`${tab}@${width}: overflow ${over}, sign-out past edge by ${Math.round(out)}`);
    }
  }
  expect(bad).toEqual([]);
});
