/**
 * Layout verification: Settings + Agents pages use the widened layout with no
 * dead right-hand space at 1600px, and collapse correctly at 900px.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4747';
const results: string[] = [];
const ok = (name: string, cond: boolean): void => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) process.exitCode = 1;
};

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  { const fs = await import('node:fs');
    const token = fs.readFileSync(fs.realpathSync(process.env.HOME + '/.clockwork/api-token'), 'utf8').trim();
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token); }
  await page.reload({ waitUntil: 'networkidle' });

  // Navigate to Settings via hash routing
  await page.goto(`${BASE}/#settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const settingsPage = page.locator('.settings-page');
  ok('settings uses .settings-page class', (await settingsPage.count()) > 0);
  if ((await settingsPage.count()) > 0) {
    const box = await settingsPage.first().boundingBox();
    const mainBox = await page.locator('main.main').boundingBox();
    ok('settings width > 1000px at 1600 viewport', (box?.width ?? 0) > 1000);
    ok('settings fills most of main (no huge dead zone)', (box?.width ?? 0) > (mainBox?.width ?? 9999) * 0.62);
    const grid = page.locator('.settings-grid');
    ok('two-column grid present', (await grid.count()) === 1);
    if ((await grid.count()) === 1) {
      const gbox = await grid.boundingBox();
      const cols = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      ok('grid renders 2 columns at wide viewport', cols === 2 && (gbox?.width ?? 0) > 800);
    }
  }

  // Agents tab via hash routing
  await page.goto(`${BASE}/#agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const agentsPage = page.locator('.agents-page');
  ok('agents uses .agents-page class', (await agentsPage.count()) > 0);
  if ((await agentsPage.count()) > 0) {
    const box = await agentsPage.first().boundingBox();
    ok('agents width > 1100px at 1600 viewport', (box?.width ?? 0) > 1100);
  }

  // Narrow viewport collapse
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${BASE}/#settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const grid2 = page.locator('.settings-grid');
  if ((await grid2.count()) === 1) {
    const cols2 = await grid2.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    ok('settings grid collapses to 1 column at 900px', cols2 === 1);
  }

  await browser.close();
  console.log(results.join('\n'));
}

void main();
