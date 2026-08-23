import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(1200);
  const txt = await page.locator('main').innerText();
  const i = txt.indexOf('Providers');
  console.log('PROVIDERS SECTION:', txt.slice(i, i + 300).replace(/\n/g, ' | '));
  await browser.close();
};
void run();
