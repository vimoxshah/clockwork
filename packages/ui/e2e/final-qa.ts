/* Final QA: new surfaces — task filter, calendars settings, human events styling, palette, themes. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const issues: string[] = [];
const note = (m: string): void => { issues.push(m); console.log('ISSUE:', m); };
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => note(`PAGEERROR: ${e.message.slice(0, 150)}`));
  page.on('response', async (r) => { if (r.status() >= 500) console.log(`HTTP ${r.status()} ${r.url().split('?')[0]}`); });
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // calendar default + human legend present in styles
  console.log('CAL DEFAULT:', await page.locator('.cal-grid').count() > 0);

  // Tasks filter UI
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await page.waitForTimeout(800);
  if (!(await page.locator('[data-testid=task-filter]').count())) note('task filter missing');
  else {
    await page.fill('[data-testid=task-filter]', 'Hermes');
    await page.waitForTimeout(300);
    const n = await page.locator('.tasklist-row').count();
    console.log('FILTER Hermes rows:', n);
    if (n === 0) note('filter found no Hermes task (expected ≥1)');
    // status tabs
    await page.getByRole('tab', { name: 'paused' }).click();
    await page.waitForTimeout(200);
    console.log('PAUSED TAB OK');
    await page.getByRole('tab', { name: 'all' }).click();
    await page.fill('[data-testid=task-filter]', '');
  }

  // Settings → Calendars
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(700);
  if (!(await page.locator('[data-testid=ics-url]').count())) note('Calendars/ICS input missing');
  else console.log('ICS INPUT OK');
  const stext = await page.locator('main').innerText();
  console.log('HAS PROVIDERS:', stext.includes('Providers'), '| HAS SHORTCUTS:', stext.includes('Keyboard shortcuts'), '| HERMES CARD:', stext.includes('Hermes Agent'));

  // both themes readable
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/final-${theme}.png` });
  }
  // restore
  await page.evaluate(() => localStorage.removeItem('clockwork.theme'));

  await browser.close();
  console.log('\n=== FINAL-QA RESULT:', issues.length === 0 ? 'NO ISSUES' : `${issues.length} ISSUES`);
};
void run();
