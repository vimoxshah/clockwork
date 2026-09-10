/* Capture the 9 real product screenshots for the landing page.
 *
 * T1-14. Two things had to change before this could run at all.
 *
 * `waitUntil: 'networkidle'` NEVER RESOLVES against this app: the UI opens a
 * long-lived SSE stream at mount (`openEventStream`, packages/ui/src/api.ts),
 * so the network is never idle and page.goto() times out at 30s. Found while
 * building the CI smoke job (T1-13); every other script under e2e/ still has
 * this bug. Wait for `load` plus a control that is on every screen instead.
 *
 * And BASE / CLOCKWORK_HOME are overridable now, so a reshoot runs against a
 * seeded throwaway daemon rather than whatever the developer's real install
 * happens to contain. The shipped shots used to show `daemon 0.1.0`, four
 * failed runs and $0.00 costs, because they were taken against exactly that.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const HOME_DIR = process.env.CLOCKWORK_HOME ?? homedir() + '/.clockwork';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4747';
const TOKEN = readFileSync(HOME_DIR + '/api-token', 'utf8').trim();
// Anchored to THIS FILE, not the shell's cwd. The relative form wrote to
// packages/landing-page/screens when run from packages/ui/e2e — a directory
// that should not exist — and left the real shots untouched while reporting
// success.
const OUT = new URL('../../../landing-page/screens', import.meta.url).pathname;
const run = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.addInitScript(() => { localStorage.setItem('clockwork.theme', 'dark'); });
  await page.goto(BASE, { waitUntil: 'load' });
  // The persistent nav is the readiness signal — it is on every screen.
  await page.getByRole('button', { name: '+ New task' }).waitFor({ timeout: 20_000 });
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
