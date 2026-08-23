/* Capture the 9 real product screenshots for the landing page. */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const OUT = '../../landing-page/screens';
const run = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.addInitScript(() => { localStorage.setItem('clockwork.theme', 'dark'); });
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // light theme for consistency
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });

  // 01 calendar month
  await page.screenshot({ path: `${OUT}/01-calendar-month.png` });
  // 02 composer
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.waitForTimeout(900);
  await page.fill('#c-name', 'Nightly dependency triage');
  await page.fill('#c-prompt', 'Review outdated dependencies, group minor upgrades, run tests, and open a PR.');
  await page.screenshot({ path: `${OUT}/02-task-composer.png` });
  // 03 agent profile (Agents tab cards)
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/03-agent-profile.png` });
  // 04 inbox list
  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click();
  await page.waitForTimeout(900);
  const rows = page.locator('.inbox-row');
  if (await rows.count()) await rows.first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/05-run-report.png` });
  await page.screenshot({ path: `${OUT}/06-inbox.png` });
  // 07 command palette
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/07-command-palette.png` });
  await page.keyboard.press('Escape');
  // 08 provider selection (composer provider segment)
  await page.keyboard.press('Meta+n');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/08-provider-selection.png` });
  // 09 tasks
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/09-approvals-tasks.png` });
  await browser.close();
  console.log('screens captured to', OUT);
};
void run();
