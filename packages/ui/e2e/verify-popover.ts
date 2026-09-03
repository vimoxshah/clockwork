/* Verify the model-selector popover now matches its trigger width (§18/§26). */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const OUT = homedir() + '/Desktop/clockwork-byok-audit/verify';

const run = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(900);
  await page.getByTestId('connect-provider-btn').first().click();
  await page.waitForTimeout(600);

  await page.getByTestId('provider-card-deepseek').click();
  await page.waitForTimeout(500);
  await page.getByTestId('api-key-input').fill('sk-dummy-not-a-real-key-000');
  await page.waitForTimeout(300);
  await page.getByTestId('credentials-next').click();
  await page.waitForTimeout(700);

  await page.getByTestId('model-selector-trigger').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/B-model-popover.png` });

  const m = await page.evaluate(() => {
    const trig = document.querySelector('[data-testid="model-selector-trigger"]') as HTMLElement | null;
    const pop = document.querySelector('[data-radix-popper-content-wrapper] [role="listbox"]')?.closest('[class*="rounded-xl"]') as HTMLElement | null;
    if (!trig || !pop) return null;
    const t = trig.getBoundingClientRect(); const p = pop.getBoundingClientRect();
    return { triggerW: Math.round(t.width), popoverW: Math.round(p.width), deltaPx: Math.round(p.width - t.width) };
  });
  console.log('WIDTHS:', JSON.stringify(m));
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
