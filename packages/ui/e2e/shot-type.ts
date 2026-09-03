/* Look at the swept type on a dense screen. */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const OUT = homedir() + '/Desktop/clockwork-byok-audit/verify';
const run = async (): Promise<void> => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/F-type-settings.png` });
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/G-type-agents.png` });
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
