import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 160)));
  page.on('response', async (r) => {
    if (r.status() >= 400) console.log('HTTP', r.status(), r.url().split('?')[0]);
  });
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.waitForTimeout(300);
  await page.fill('#c-name', 'E2E smoke task');
  await page.fill('#c-prompt', 'x');
  await page.fill('#c-usd', '1');
  await page.getByRole('tab', { name: 'ASAP' }).last().click();
  await page.getByRole('button', { name: 'Book it' }).click();
  await page.waitForTimeout(1500);
  console.log('URL:', page.url());
  const err = await page.locator('.error-banner').count();
  if (err) console.log('BANNER:', (await page.locator('.error-banner').first().innerText()).slice(0, 200));
  // is there a toast covering things?
  const toasts = await page.locator('div.fixed.right-4').count();
  console.log('toasts visible:', toasts);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.waitForTimeout(1000);
  console.log('rows with E2E smoke:', await page.locator('.tasklist-row', { hasText: 'E2E smoke task' }).count());
  await browser.close();
};
void run();
