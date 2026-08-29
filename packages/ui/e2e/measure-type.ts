/* Sample computed type + container heights so a leading change is detectable
   as a number, not a vibe. Run on both builds and diff. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const OUT = process.argv[2] || '/tmp/type-measure.json';

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(1400);

  const data = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    // distribution of computed font-size/line-height across every rendered element
    const dist: Record<string, number> = {};
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el as Element);
      if (!(el as HTMLElement).innerText) return;
      const k = `${cs.fontSize}/${cs.lineHeight}`;
      dist[k] = (dist[k] || 0) + 1;
    });
    out.fontDistribution = Object.fromEntries(Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 14));
    // total document height = the layout-shift canary
    out.docHeight = document.documentElement.scrollHeight;
    // a few dense containers (inline — no named fn, esbuild __name breaks evaluate)
    const a = document.querySelector('[data-testid^="byok-row-"]') as HTMLElement | null;
    const b = document.querySelector('.card') as HTMLElement | null;
    out.byokRow = a ? Math.round(a.getBoundingClientRect().height) : null;
    out.firstCard = b ? Math.round(b.getBoundingClientRect().height) : null;
    return out;
  });
  writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('wrote', OUT);
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
