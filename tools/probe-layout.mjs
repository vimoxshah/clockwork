/**
 * How many things scroll, and where the buttons actually sit.
 *
 * Two reports the jsdom suites cannot produce, for two complaints that are
 * geometric: "why do we have 2 scroll" and "see alignment of all buttons".
 *
 *   pnpm build
 *   CLOCKWORK_HOME=/tmp/cw-probe-home CLOCKWORK_PORT=4790 node packages/daemon/dist/main.js &
 *   node tools/probe-layout.mjs
 *
 * scrollers  — every element whose scrollHeight exceeds its clientHeight,
 *              measured from scroll position zero on each tab. The answer must
 *              be `.main` alone on a long page and nothing on a short one.
 *              Settings used to report two: <html> over by 1161px and .main
 *              over by 2242px, because one hidden file input escaped the clip.
 * escapees   — positioned descendants of .main whose containing block is the
 *              page rather than .main. This is what makes the second scrollbar,
 *              and it is invisible in a screenshot.
 * rows       — per action row: the input's right edge, and each button's left
 *              edge and offset from ITS OWN input's centre. Measuring against
 *              the card's first input instead is how the SMTP row's misplaced
 *              Save/Clear stayed hidden.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.CLOCKWORK_PORT ?? '4790';
const HOME = process.env.CLOCKWORK_HOME ?? '/tmp/cw-probe-home';
const token = readFileSync(`${HOME}/api-token`, 'utf8').trim();
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);

for (const tab of ['tasks', 'settings', 'calendar', 'inbox', 'analytics']) {
  await page.goto(`${base}/#/${tab}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /got it/i }).click({ timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const de = document.documentElement;
    const bd = document.body;
    const scrollers = [];
    for (const el of [de, bd, ...document.querySelectorAll('body *')]) {
      const cs = getComputedStyle(el);
      const canScroll = el === de || el === bd || cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      if (canScroll && el.scrollHeight > el.clientHeight + 1) {
        scrollers.push({
          who: el === de ? '<html>' : el === bd ? '<body>' : (el.className || el.tagName).toString().slice(0, 40),
          over: el.scrollHeight - el.clientHeight,
        });
      }
    }
    const main = document.querySelector('.main');
    const escapees = [];
    if (main && getComputedStyle(main).position === 'static') {
      for (const el of main.querySelectorAll('*')) {
        if (getComputedStyle(el).position !== 'absolute') continue;
        // Positioned against the page, not against anything inside .main.
        let anc = el.parentElement;
        let anchored = false;
        while (anc && anc !== main) {
          if (getComputedStyle(anc).position !== 'static') { anchored = true; break; }
          anc = anc.parentElement;
        }
        if (!anchored) {
          const r = el.getBoundingClientRect();
          escapees.push({ sel: (el.className || el.tagName).toString().slice(0, 40), bottom: Math.round(r.bottom) });
        }
      }
    }
    return { scrollers, escapees };
  });
  console.log(`${tab.padEnd(10)} scrollers=${JSON.stringify(m.scrollers)} escapees=${JSON.stringify(m.escapees)}`);
}

await page.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.settings-page', { timeout: 10000 });
await page.waitForTimeout(2200);
const rows = await page.evaluate(() => {
  const out = [];
  const wide = [];
  const rightEdges = new Set();
  for (const card of document.querySelectorAll('.settings-card')) {
    const cr = card.getBoundingClientRect();
    for (const kid of card.children) {
      const k = kid.getBoundingClientRect();
      if (k.width > 0) rightEdges.add(Math.round(k.right));
    }
    for (const btn of card.querySelectorAll('button')) {
      const b = btn.getBoundingClientRect();
      if (b.width > 240) wide.push({ t: (btn.textContent || '').trim().slice(0, 26), w: Math.round(b.width) });
      // The input this button actually belongs to: the nearest one sharing a row.
      const near = [...card.querySelectorAll('input, textarea')]
        .map((i) => ({ i, r: i.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0)
        .sort((x, y) => Math.abs(x.r.top - b.top) - Math.abs(y.r.top - b.top))[0];
      out.push({
        card: (card.querySelector('label, strong, h3')?.textContent ?? '').trim().slice(0, 24),
        btn: (btn.textContent || '').trim().slice(0, 22),
        x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width),
        inputRight: near ? Math.round(near.r.right) : null,
        dCentre: near ? Math.round((b.top + b.bottom) / 2 - (near.r.top + near.r.bottom) / 2) : null,
      });
    }
    void cr;
  }
  return { rows: out, wideButtons: wide, cardRightEdges: [...rightEdges].sort((a, b) => a - b) };
});
console.log('\ncard right edges (should be one value):', rows.cardRightEdges.filter((e) => e > 900));
console.log('buttons stretched past 240px (should be empty):', JSON.stringify(rows.wideButtons));
console.log('\naction rows — input right edge, button left edge, offset from its own input:');
for (const r of rows.rows) {
  if (r.inputRight === null) continue;
  console.log(`  ${r.card.padEnd(24)} ${r.btn.padEnd(22)} inputRight=${String(r.inputRight).padStart(5)} btnX=${String(r.x).padStart(5)} dCentre=${String(r.dCentre).padStart(5)}`);
}
await browser.close();
