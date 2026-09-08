/**
 * Every "what time?" control in the app, in WEBKIT — which is the point.
 *
 * The Tauri window is a WKWebView, where a native <select> or <input
 * type="time"> is an OS widget drawn by macOS: it ignores the theme, ignores
 * dark mode, and is the thing that was reported twice as "not able to select
 * the time". Chromium draws its own styled versions, so a Chromium check
 * passes while the fault is still on screen. shoot-picker.mjs covers one site;
 * this covers all four.
 *
 *   pnpm build
 *   ./node_modules/.bin/playwright install webkit     # once
 *   CLOCKWORK_HOME=/tmp/cw-probe-home CLOCKWORK_PORT=4790 node packages/daemon/dist/main.js &
 *   node tools/shoot-time-fields.mjs
 *
 * The negative is the whole report: zero native controls at every site, with
 * the themed control present so "zero" cannot be satisfied by rendering none.
 * It also measures the frequency tablist, because inside the composer's 2/5
 * side column the four tabs had 250px to share and needed 251, so "Monthly"
 * broke onto a second row.
 */
import { webkit } from 'playwright';
import { readFileSync } from 'node:fs';

const HOME = process.env.CLOCKWORK_HOME ?? '/tmp/cw-probe-home';
const PORT = process.env.CLOCKWORK_PORT ?? '4790';
const token = readFileSync(`${HOME}/api-token`, 'utf8').trim();

const b = await webkit.launch();
const c = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const p = await c.newPage();
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });

const findings = [];
const check = (site, ok, detail) => {
  findings.push({ site, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${site}  ${detail}`);
};

/** Native controls anywhere in the live DOM, not just under one subtree. */
async function natives() {
  return p.evaluate(() => ({
    selects: document.querySelectorAll('select').length,
    timeInputs: document.querySelectorAll('input[type="time"],input[type="datetime-local"]').length,
  }));
}

/**
 * How many ROWS a tablist occupies, and which labels broke across lines.
 *
 * Measuring only the per-tab line count passed a screenshot showing "Every N
 * min | Daily | Weekly" on one row and "Monthly" stranded on a second: no
 * single label had wrapped, and the row was still broken. The count of
 * distinct top offsets is the thing that was actually wrong.
 */
async function tabRows(selector) {
  return p.evaluate((sel) => {
    const list = document.querySelector(sel);
    if (!list) return null;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const tops = new Set(tabs.map((el) => Math.round(el.getBoundingClientRect().top)));
    const line = tabs.length ? parseFloat(getComputedStyle(tabs[0]).lineHeight) || 16 : 16;
    return {
      rows: tops.size,
      labels: tabs.map((el) => el.textContent.trim()),
      multiLine: tabs
        .filter((el) => (el.getBoundingClientRect().height - 8) / line > 1.4)
        .map((el) => el.textContent.trim()),
    };
  }, selector);
}

// ── Composer ───────────────────────────────────────────────────────────────
await p.getByRole('button', { name: /new task/i }).first().click({ timeout: 10000 });
await p.waitForSelector('#c-prompt', { timeout: 12000 });
await p.getByRole('button', { name: /got it/i }).click({ timeout: 1500 }).catch(() => {});
await p.waitForTimeout(600);

await p.getByRole('tab', { name: 'Recurring' }).click();
await p.waitForTimeout(500);

async function checkTabRows(name, sel) {
  const t = await tabRows(sel);
  check(`${name} tabs sit on one row`, t !== null && t.rows === 1 && t.multiLine.length === 0,
    t === null ? 'tablist not found' : `rows=${t.rows} multiLine=${JSON.stringify(t.multiLine)} labels=${JSON.stringify(t.labels)}`);
}
await checkTabRows('composer/frequency', '[aria-label="Repeat frequency"]');

// INTERVAL is the default tab: the hour window lives here.
await p.getByRole('tab', { name: 'Every N min', exact: true }).click();
await p.waitForTimeout(400);
await checkTabRows('composer/every-N', '[aria-label="Interval"]');
await p.screenshot({ path: '/tmp/tf-interval.png' });
{
  const n = await natives();
  const themed = await p.locator('[data-testid="c-from-hour"], [data-testid="c-from-hour"]').count()
    + await p.locator('[data-testid="c-to-hour"]').count();
  check('composer/interval hour window', n.selects === 0 && n.timeInputs === 0 && themed > 0,
    `natives=${JSON.stringify(n)} themedHourFields=${themed}`);
}

// The end of the window must be able to say 24:00, which no time input can.
await p.locator('[data-testid="c-to-hour"]').click();
await p.waitForTimeout(400);
{
  const labels = await p.locator('[role="option"]').allTextContents();
  check('composer/interval end offers 24:00', labels.includes('24:00'),
    `options end with ${JSON.stringify(labels.slice(-3))}`);
  await p.screenshot({ path: '/tmp/tf-interval-hours.png' });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
}

// A two-digit field must not be sized like a prose field. This is the check
// styles.css's `input[type='number'] { width: 100% }` defeats: it outranks
// every Tailwind `w-*` utility, so a width class on an <Input> is dead and
// nothing says so until the field lands in a wide row.
async function widthOf(sel) {
  return p.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().width) : null;
  }, sel);
}

for (const freq of ['Daily', 'Weekly', 'Monthly']) {
  await p.getByRole('tab', { name: freq }).click();
  await p.waitForTimeout(400);
  const n = await natives();
  const themed = await p.locator('[data-testid="c-rtime-hour"]').count();
  check(`composer/${freq.toLowerCase()} "At time"`, n.selects === 0 && n.timeInputs === 0 && themed === 1,
    `natives=${JSON.stringify(n)} themedAtTime=${themed}`);
}
{
  const w = await widthOf('#c-dom');
  check('composer/day-of-month is sized for two digits', w !== null && w <= 160, `width=${w}px`);
}
await p.screenshot({ path: '/tmp/tf-weekly.png' });

// "what if i want to set recurring at daily 10 AM?" — and at 10:07, because
// "make sure we allow user to select any time" means the minute must not be
// stuck on a grid. The five previewed runs are what proves the rule that
// reaches the daemon carries the time, not just the trigger label.
await p.getByRole('tab', { name: 'Daily', exact: true }).click();
await p.waitForTimeout(400);
await p.locator('[data-testid="c-rtime-hour"]').click();
await p.waitForTimeout(400);
await p.getByRole('option', { name: '10 AM', exact: true }).click();
await p.waitForTimeout(300);
{
  const minutes = await p.locator('[data-testid="c-rtime-minute"]').click().then(async () => {
    const n = await p.locator('[role="option"]').count();
    await p.getByRole('option', { name: '07', exact: true }).click();
    return n;
  });
  await p.waitForTimeout(700);
  const hour = (await p.locator('[data-testid="c-rtime-hour"]').textContent()).trim();
  const minute = (await p.locator('[data-testid="c-rtime-minute"]').textContent()).trim();
  const runs = (await p.locator('[data-testid="next-runs"]').textContent().catch(() => '') ?? '')
    .replace(/\s+/g, ' ');
  check('composer/daily at 10:07 AM', hour === '10 AM' && minute === '07',
    `trigger reads ${JSON.stringify(`${hour}:${minute}`)}`);
  check('composer/every minute is offered', minutes === 60, `minute options=${minutes}`);
  check('composer/the preview carries the chosen time', /10:07/.test(runs),
    `next runs: ${runs.slice(0, 110)}`);
}
await p.screenshot({ path: '/tmp/tf-attime.png' });
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// ── Settings → Office hours ────────────────────────────────────────────────
await p.keyboard.press('Escape');
await p.waitForTimeout(400);
const nav = p.getByRole('button', { name: /settings/i }).or(p.getByRole('link', { name: /settings/i }));
await nav.first().click({ timeout: 8000 })
  .catch(() => p.goto(`http://127.0.0.1:${PORT}/#/settings`, { waitUntil: 'domcontentloaded' }));
await p.waitForSelector('.settings-page', { timeout: 12000 });
await p.getByRole('button', { name: /got it/i }).click({ timeout: 2000 }).catch(() => {});
await p.waitForSelector('.office-hours-form', { timeout: 12000 });
await p.locator('.office-hours-form').scrollIntoViewIfNeeded();
await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/tf-office-hours.png' });
{
  const n = await natives();
  const themed = await p.locator('[data-testid="oh-start-hour"], [data-testid="oh-end-hour"]').count();
  check('settings/office hours', n.selects === 0 && n.timeInputs === 0 && themed === 2,
    `natives=${JSON.stringify(n)} themedFields=${themed}`);
}
await p.locator('[data-testid="oh-end-hour"]').click();
await p.waitForTimeout(400);
{
  const labels = await p.locator('[role="option"]').allTextContents();
  check('settings/office hours end offers 24:00', labels.includes('24:00'),
    `options end with ${JSON.stringify(labels.slice(-3))}`);
  await p.screenshot({ path: '/tmp/tf-oh-hours.png' });
}

// ── Every tablist, at both widths ──────────────────────────────────────────
// The nowrap + flex-wrap change to Segmented is global: Provider, Schedule
// type, Permission mode and the theme switcher all inherit it. A whole tab
// moving to a second row is better than a label splitting mid-phrase, but it
// is still a layout change on screens this task never asked about.
await p.keyboard.press('Escape');
for (const width of [1440, 430]) {
  await p.setViewportSize({ width, height: 1000 });
  // Back to the composer: it carries four of the app's tablists (Provider,
  // Permission mode, Schedule type, Repeat frequency) on one screen.
  await p.getByRole('button', { name: /new task/i }).first().click({ timeout: 10000 }).catch(() => {});
  await p.waitForSelector('#c-prompt', { timeout: 12000 }).catch(() => {});
  await p.getByRole('tab', { name: 'Recurring' }).click({ timeout: 4000 }).catch(() => {});
  await p.waitForTimeout(500);
  const rows = await p.evaluate(() =>
    [...document.querySelectorAll('[role="tablist"]')].map((l) => {
      const tabs = [...l.querySelectorAll('[role="tab"]')];
      const line = tabs.length ? parseFloat(getComputedStyle(tabs[0]).lineHeight) || 16 : 16;
      return {
        name: l.getAttribute('aria-label') ?? '(unlabelled)',
        rows: new Set(tabs.map((e) => Math.round(e.getBoundingClientRect().top))).size,
        split: tabs
          .filter((e) => (e.getBoundingClientRect().height - 8) / line > 1.4)
          .map((e) => e.textContent.trim()),
        w: Math.round(l.getBoundingClientRect().width),
      };
    }),
  );
  console.log(`   tablists @${width}px:`, JSON.stringify(rows));
  await p.screenshot({ path: `/tmp/tf-tablists-${width}.png` });
  // Two different claims, because they are different faults. At a normal
  // window every tablist must fit on one row. At 430px the app is deliberately
  // cramped and a whole tab moving down is the graceful answer — what must
  // never happen is a LABEL splitting mid-phrase, which is what the old
  // flex-shrink did to "Every N min".
  const split = rows.filter((r) => r.split.length > 0);
  check(`tablists at ${width}px keep labels whole`, split.length === 0,
    `split labels: ${JSON.stringify(split)}`);
  if (width >= 1440) {
    const multi = rows.filter((r) => r.rows > 1);
    check(`tablists at ${width}px sit on one row`, multi.length === 0,
      `multi-row: ${JSON.stringify(multi)}`);
  }
}

await b.close();
const failed = findings.filter((f) => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} checks pass`);
process.exit(failed.length === 0 ? 0 : 1);
