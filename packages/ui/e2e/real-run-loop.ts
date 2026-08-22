/**
 * REAL book→run→review through the redesigned UI with the LIVE engine.
 * Books via the composer form, watches the calendar/inbox, opens the report
 * when the run completes, and asserts the transcript is readable.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const run = async (): Promise<number> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });

  // ---- BOOK through the composer (real engine, fires in ~2 min) ----
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.fill('#c-name', 'UI-driven real run');
  await page.fill('#c-prompt', 'Reply with exactly: UI-REAL-LOOP-OK');
  await page.fill('#c-usd', '1');
  // schedule once ~3-7 min out, snapped to the picker's 5-minute slots
  const target = new Date(Math.ceil((Date.now() + 150_000) / 300_000) * 300_000);
  await page.locator('#c-when').click();
  await page.locator('[role="dialog"] table td button[aria-selected="true"]').first().click();
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  await page.locator('[role="dialog"] select[aria-label="Hour"]').selectOption(hh);
  await page.locator('[role="dialog"] select[aria-label="Minute"]').selectOption(mm);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Book it' }).click();
  await page.waitForTimeout(600);

  // lands back on calendar; booking visible on today's cell or day panel
  check('booked — back on calendar', page.url().includes('#/calendar') || (await page.locator('.cal-grid').count()) === 1);

  // switch to live engine for this daemon? The launchd daemon runs WITHOUT CW_ENGINE,
  // so this is a REAL claude -p run. Poll inbox until report lands (max ~6 min).
  console.log('… waiting for real engine run to complete (polling inbox) …');
  let done = false;
  for (let i = 0; i < 60; i++) {
    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.waitForTimeout(500);
    const row = page.locator('.inbox-row', { hasText: 'UI-driven real run' });
    if ((await row.count()) > 0) {
      const stateTxt = await row.first().locator('.chip').innerText().catch(() => '');
      if (/completed|failed/i.test(stateTxt)) {
        done = true;
        break;
      }
      process.stdout.write(`  t=${i * 6}s state=${stateTxt}\n`);
    }
    await page.waitForTimeout(5500);
  }
  check('run reached terminal state', done);

  // open the report
  await page.locator('.inbox-row', { hasText: 'UI-driven real run' }).first().click();
  await expectSel(page, '.report h2', 'report view opens');
  const body = await page.locator('.report').innerText();
  check('report contains engine reply marker', body.includes('UI-REAL-LOOP-OK'), extract(body));
  check('report shows cost', /\$\d/.test(body));

  // transcript expands
  const trBtn = page.locator('.transcript button');
  if ((await trBtn.count()) > 0) {
    await trBtn.first().click();
    await expectSel(page, '.transcript pre', 'transcript expands');
  }

  await page.screenshot({ path: '/tmp/cw-real-report.png' });
  await browser.close();

  async function expectSel(page: import('playwright').Page, sel: string, name: string): Promise<void> {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      check(name, true);
    } catch {
      check(name, false, `missing ${sel}`);
    }
  }
  function extract(body: string): string {
    const idx = body.indexOf('summary');
    return body.slice(idx, idx + 80).replace(/\n/g, ' ');
  }
  return failures;
};

run().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
