import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE:', m.text().slice(0, 200)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(1500);
  const main = await page.locator('.main').innerHTML();
  console.log('MAIN-HTML-SNIPPET:', main.slice(0, 600).replace(/\s+/g, ' '));
  await browser.close();
};
void run();
