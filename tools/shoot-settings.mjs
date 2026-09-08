/**
 * The pixel check behind SET-1, made repeatable.
 *
 * jsdom has no layout engine, so packages/ui/test/settings-layout.test.tsx can
 * only assert the STRUCTURE the three reported defects needed to exist. This is
 * the other half: it renders the real app against the real stylesheet in
 * Chromium at 1440px and 430px, prints the measurements the complaints were
 * about, and writes screenshots to look at.
 *
 * It talks to an ISOLATED daemon so it can never touch a real one:
 *
 *   pnpm build
 *   CLOCKWORK_HOME=/tmp/cw-shot-home CLOCKWORK_PORT=4790 node packages/daemon/dist/main.js &
 *   node tools/shoot-settings.mjs
 *
 * What to look for, in the numbers it prints:
 *   - `cards` at 1440 must show three distinct x values on the FIRST row, or
 *     the columns are not starting at the top of the page.
 *   - `office-hours inputs` must show oh-start and oh-end at the SAME y with
 *     the SAME width, adjacent in x. That is the "To floats far right of
 *     inputs of three different widths" complaint.
 *   - no negative x at 430, or the page overflows its viewport.
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
  const nav = page.getByRole('button', { name: /settings/i }).or(page.getByRole('link', { name: /settings/i }));
  await nav.first().click({ timeout: 8000 }).catch(() => page.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' }));
  await page.waitForSelector('.settings-page', { timeout: 10000 });
  await page.getByRole('button', { name: /got it/i }).click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);

  const m = await page.evaluate(() => {
    const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    const cards = [...document.querySelectorAll('.settings-card')].map((c) => ({
      title: (c.querySelector('.section-title')?.textContent ?? '').trim(), ...round(c.getBoundingClientRect()),
    }));
    const oh = document.querySelector('.office-hours-form');
    return {
      cols: getComputedStyle(document.querySelector('.settings-page')).gridTemplateColumns,
      cards,
      ohInputs: oh ? [...oh.querySelectorAll('input')].map((i) => ({ id: i.id, ...round(i.getBoundingClientRect()) })) : [],
    };
  });
  console.log(`[${tag}] cols=${m.cols}`);
  console.log(`[${tag}] first row=${JSON.stringify(m.cards.filter((c) => c.y === m.cards[0].y).map((c) => `${c.title}@${c.x}`))}`);
  console.log(`[${tag}] office-hours inputs=${JSON.stringify(m.ohInputs)}`);
  const overflow = m.cards.filter((c) => c.x < 0);
  console.log(`[${tag}] cards overflowing the viewport: ${overflow.length}`);

  const need = await page.evaluate(() => (document.querySelector('.settings-page')?.getBoundingClientRect().height ?? 0) + 300);
  await page.setViewportSize({ width: w, height: Math.min(Math.ceil(need), 30000) });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/tmp/settings-${tag}.png` });
  console.log(`[${tag}] wrote /tmp/settings-${tag}.png`);
  await ctx.close();
}
await browser.close();
