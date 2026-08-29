/* (a) Test-connection label must sit on ONE line. (b) closing a modal must
   tear down the scrim rather than leave it behind. */
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
  await page.waitForTimeout(400);
  await page.getByTestId('api-key-input').fill('sk-dummy-not-a-real-key-000');
  await page.getByTestId('credentials-next').click();
  await page.waitForTimeout(700);
  await page.getByTestId('model-selector-trigger').click();
  await page.waitForTimeout(500);
  await page.getByRole('option').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/E-test-btn.png` });

  const btn = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="test-connection-btn"]') as HTMLElement | null;
    if (!b) return null;
    const cs = getComputedStyle(b);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return { h: Math.round(b.getBoundingClientRect().height), lineHeight: Math.round(lh),
             lines: Math.round(b.getBoundingClientRect().height / lh), whiteSpace: cs.whiteSpace };
  });
  console.log('TEST_BTN:', JSON.stringify(btn));

  // close and confirm the scrim is gone
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const ov = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && s.inset === '0px' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    return { lingeringScrims: ov.length, dialogOpen: !!document.querySelector('[data-testid="provider-connect-flow"]') };
  });
  console.log('AFTER_CLOSE:', JSON.stringify(after));
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
