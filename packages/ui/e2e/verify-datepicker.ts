/* Regression check: overflow-y-auto now applies to EVERY PopoverContent.
   Confirm the calendar grid is not clipped or scrollbar-shifted. */
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

  await page.getByRole('button', { name: /New task/i }).first().click();
  await page.waitForTimeout(900);
  await page.locator('#c-when').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/D-datepicker.png` });

  const m = await page.evaluate(() => {
    const pop = document.querySelector('[data-radix-popper-content-wrapper] [class*="rounded-xl"]') as HTMLElement | null;
    if (!pop) return null;
    const cs = getComputedStyle(pop);
    return {
      overflowY: cs.overflowY,
      maxHeight: cs.maxHeight,
      clientH: pop.clientHeight,
      scrollH: pop.scrollHeight,
      scrolls: pop.scrollHeight > pop.clientHeight + 1,
      scrollbarPx: pop.offsetWidth - pop.clientWidth,
    };
  });
  console.log('DATEPICKER_POPOVER:', JSON.stringify(m));
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
