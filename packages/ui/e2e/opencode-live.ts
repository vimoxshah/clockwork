/**
 * REAL provider proof: book an OpenCode task through the redesigned composer,
 * wait for the scheduled fire, open the report, assert the engine reply.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();

let failures = 0;
const check = (n: string, ok: boolean, x = ''): void => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) failures++;
};

const run = async (): Promise<number> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 850 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });

  // provider segmented shows all three detected
  await page.getByRole('button', { name: '+ New task' }).click();
  for (const p of ['Claude Code', 'Codex CLI', 'OpenCode']) {
    check(`provider segment "${p}"`, (await page.getByRole('tab', { name: p }).count()) === 1);
  }
  // select OpenCode
  await page.getByRole('tab', { name: 'OpenCode' }).click();
  check('OpenCode selected', (await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'OpenCode' }).count()) === 1);

  await page.fill('#c-name', 'OpenCode live run');
  await page.fill('#c-prompt', 'Reply with exactly: OPENCODE-UI-OK');
  await page.fill('#c-usd', '1');

  // schedule ~4 min out via themed picker
  const target = new Date(Math.ceil((Date.now() + 180_000) / 300_000) * 300_000);
  await page.locator('#c-when').click();
  await page.locator('[role="dialog"] table td button[aria-selected="true"]').first().click();
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  await page.locator('[role="dialog"] select[aria-label="Hour"]').selectOption(hh);
  await page.locator('[role="dialog"] select[aria-label="Minute"]').selectOption(mm);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Book it' }).click();
  await page.waitForTimeout(700);
  check('booked → calendar', (await page.locator('.cal-grid').count()) === 1);

  console.log(`… waiting for OpenCode run @ ${target.toLocaleTimeString()} …`);
  let state = '';
  for (let i = 0; i < 70; i++) {
    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.waitForTimeout(600);
    const row = page.locator('.inbox-row', { hasText: 'OpenCode live run' });
    if ((await row.count()) > 0) {
      state = await row.first().locator('.chip').innerText().catch(() => '');
      if (/completed|failed|cancelled/i.test(state)) break;
      process.stdout.write(`  t=${i * 6}s ${state}\n`);
    }
    await page.waitForTimeout(5400);
  }
  check('terminal state reached', /completed|failed/i.test(state), state);

  await page.locator('.inbox-row', { hasText: 'OpenCode live run' }).first().click();
  await page.waitForSelector('.report h2', { timeout: 8000 });
  const body = await page.locator('.report').innerText();
  check('report contains OPENCODE-UI-OK', body.includes('OPENCODE-UI-OK'));
  await page.screenshot({ path: '/tmp/cw-opencode-report.png' });

  await browser.close();
  return failures;
};
run().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
