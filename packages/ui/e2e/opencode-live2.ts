/**
 * Poll the in-flight OpenCode run to terminal state + verify report content.
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

  console.log('… polling in-flight OpenCode run …');
  let state = '';
  let found = false;
  for (let i = 0; i < 80; i++) {
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.waitForTimeout(700);
    const row = page.locator('.inbox-row', { hasText: 'OpenCode live run' });
    if ((await row.count()) > 0) {
      found = true;
      state = await row.first().locator('.chip').innerText().catch(() => '');
      if (/completed|failed|cancelled/i.test(state)) break;
      process.stdout.write(`  t=${i * 7}s ${state}\n`);
    }
    await page.waitForTimeout(6300);
  }
  check('run row appeared', found);
  check('terminal state reached', /completed|failed/i.test(state), state);

  if (!found) {
    await browser.close();
    return failures;
  }
  await page.locator('.inbox-row', { hasText: 'OpenCode live run' }).first().click();
  await page.waitForSelector('.report h2', { timeout: 8000 });
  const body = await page.locator('.report').innerText();
  check('report contains OPENCODE-UI-OK', body.includes('OPENCODE-UI-OK'), body.slice(0, 120).replace(/\n/g, ' '));
  check('engine shown as OpenCode', /opencode/i.test(body));
  await page.screenshot({ path: '/tmp/cw-opencode-report.png' });
  await browser.close();
  return failures;
};
run().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
