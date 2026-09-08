/**
 * The pixel check for the composer's two-column form, in the same shape as
 * tools/shoot-settings.mjs and for the same reason: jsdom has no layout
 * engine, so a test there can only assert structure. The complaint was
 * geometric — "one side is having empty space and right side is having data" —
 * so the measurement has to come from a real layout.
 *
 *   pnpm build
 *   CLOCKWORK_HOME=/tmp/cw-shot-home CLOCKWORK_PORT=4790 node packages/daemon/dist/main.js &
 *   node tools/shoot-composer.mjs
 *
 * What to look for: `dead space below the left column` is the height of the
 * gap the complaint was about — the distance from the bottom of the last
 * left-column section to the bottom of the grid row. Under ~150px is noise;
 * the screenshot showed roughly half a screen.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.CLOCKWORK_PORT ?? '4790';
const HOME = process.env.CLOCKWORK_HOME ?? '/tmp/cw-shot-home';
const token = readFileSync(`${HOME}/api-token`, 'utf8').trim();
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
for (const [w, h, tag] of [[1440, 1200, 'wide'], [430, 1400, 'narrow']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
  // NOT networkidle: the app holds an SSE stream open, so it never fires.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /new task/i }).first().click({ timeout: 8000 });
  await page.waitForSelector('[data-testid="prompt"]', { timeout: 10000 });
  await page.getByRole('button', { name: /got it/i }).click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="prompt"]')?.closest('.grid');
    if (!grid) return { error: 'composer grid not found' };
    const cols = [...grid.children].map((c) => {
      const r = c.getBoundingClientRect();
      const head = c.querySelector('h3')?.textContent ?? '(none)';
      // The gap is between where the CONTENT ends and where the COLUMN ends.
      // Comparing the two columns' bottoms measures nothing: a grid child
      // stretches to the row height by default, so both bottoms agree while
      // one of them is half empty. That is exactly the layout being reported.
      const last = c.lastElementChild?.getBoundingClientRect();
      return {
        firstHeading: head,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        bottom: Math.round(r.bottom),
        emptyBelowContent: last ? Math.round(r.bottom - last.bottom) : null,
      };
    });
    const top = Math.min(...cols.map((c) => c.y));
    const firstRow = cols.filter((c) => Math.abs(c.y - top) < 4);
    return { cols, worstEmptyColumn: Math.max(...firstRow.map((c) => c.emptyBelowContent ?? 0)) };
  });
  console.log(`\n== ${tag} (${w}x${h}) ==`);
  console.log(JSON.stringify(m, null, 2));
  await page.screenshot({ path: `/tmp/composer-${tag}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
