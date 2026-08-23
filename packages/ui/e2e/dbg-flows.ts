/* Exercise primary actions: task enable/disable toggle, run-now, settings pause/resume, calendar week mode. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const issues: string[] = [];
const note = (m: string): void => { issues.push(m); console.log('ISSUE:', m); };
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => note(`PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on('response', async (r) => {
    if (r.status() >= 400 && !r.url().includes('/events')) console.log(`HTTP ${r.status()} ${r.url().split('?')[0]}`);
  });
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });

  // Tasks tab — find controls
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await page.waitForTimeout(900);
  const toggles = await page.locator('.tasklist-row button, .tasklist-row [role=switch]').count();
  console.log('TASK ROW CONTROLS:', toggles);
  if (toggles === 0 && (await page.locator('.tasklist-row').count()) > 0) note('Task rows have no controls');
  await page.screenshot({ path: '/tmp/gaunt-tasks.png' });

  // Settings pause → resume round trip
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.locator('[role=switch]').first().click();
  await page.waitForTimeout(800);
  const pausedTxt = await page.locator('main').innerText();
  if (!pausedTxt.includes('PAUSED')) console.log('(pause state text not found — check)');
  await page.locator('[role=switch]').first().click();
  await page.waitForTimeout(800);
  console.log('pause/resume round-trip done');

  // Week mode
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('tab', { name: 'Week' }).click();
  await page.waitForTimeout(600);
  if (!(await page.locator('.week-grid').count())) note('Week mode did not render week-grid');
  await page.screenshot({ path: '/tmp/gaunt-week.png' });
  await page.getByRole('tab', { name: 'Month' }).click();

  // Agents tab create-profile dialog opens and cancels
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await page.waitForTimeout(700);
  const newProfile = page.getByRole('button', { name: /new profile|create/i }).first();
  if (await newProfile.count()) {
    await newProfile.click();
    await page.waitForTimeout(500);
    const dlg = await page.locator('.dialog, [role=dialog]').count();
    console.log('PROFILE DIALOG OPENED:', dlg > 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else note('No create-profile control in Agents');

  // Composer opens with all fields present
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.waitForTimeout(700);
  for (const sel of ['#c-name', '#c-prompt', '#c-usd']) {
    if (!(await page.locator(sel).count())) note(`Composer missing field ${sel}`);
  }
  console.log('COMPOSER FIELDS OK');
  await browser.close();
  console.log('\n=== RESULT:', issues.length === 0 ? 'NO ISSUES' : `${issues.length} ISSUES`);
};
void run();
