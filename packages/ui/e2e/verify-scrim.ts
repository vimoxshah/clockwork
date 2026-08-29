/* Visual verification of the dialog-scrim + popover-width fixes (gauntlet §26/§28). */
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
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/A-step1-scrim.png` });

  // measure the scrim empirically rather than trusting the pixels
  const scrim = await page.evaluate(() => {
    const el = document.querySelector('[data-radix-popper-content-wrapper], [data-state="open"]');
    const ov = Array.from(document.querySelectorAll('div')).find((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && s.inset === '0px' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    return ov ? { bg: getComputedStyle(ov).backgroundColor, filter: getComputedStyle(ov).backdropFilter } : null;
  });
  console.log('SCRIM:', JSON.stringify(scrim));

  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
