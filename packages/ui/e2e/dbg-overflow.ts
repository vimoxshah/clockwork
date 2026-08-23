import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 760, height: 820 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const cssApplied = await page.evaluate(() => {
    const h = document.querySelector('.health');
    return h ? getComputedStyle(h).flexWrap : 'no .health';
  });
  console.log('health flexWrap:', cssApplied);
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: Array<string> = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 20) out.push(`${el.tagName}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    });
    return out.slice(0, 10);
  });
  console.log('OVERFLOWING:', JSON.stringify(wide, null, 1));
  const mediaHit = await page.evaluate(() => window.matchMedia('(max-width: 900px)').matches);
  console.log('media query matches:', mediaHit);
  await browser.close();
};
void run();
