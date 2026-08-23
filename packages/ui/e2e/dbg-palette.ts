import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Cmd+K opens palette
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(400);
  console.log('PALETTE OPEN:', (await page.locator('.palette').count()) > 0);
  // type to filter
  await page.fill('[data-testid=palette-input]', 'inbox');
  await page.waitForTimeout(300);
  const items = await page.locator('[data-testid=palette-item]').allInnerTexts();
  console.log('FILTERED:', JSON.stringify(items));
  // Enter navigates
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  console.log('HASH AFTER ENTER:', page.url().split('#')[1] ?? '(none)');
  console.log('INBOX VISIBLE:', (await page.locator('.inbox-layout').count()) > 0);

  // Cmd+1 → calendar, Cmd+N → new task
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(400);
  console.log('CMD1 CALENDAR:', (await page.locator('.cal-grid').count()) > 0);
  await page.keyboard.press('Meta+n');
  await page.waitForTimeout(500);
  console.log('CMDN COMPOSER:', (await page.locator('#c-name').count()) > 0);

  // theme via palette
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(400);
  await page.fill('[data-testid=palette-input]', 'dark');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  console.log('THEME VIA PALETTE:', await page.evaluate(() => document.documentElement.getAttribute('data-theme')));

  // Settings shows shortcuts + providers
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(700);
  const txt = await page.locator('main').innerText();
  console.log('SHORTCUTS SECTION:', txt.includes('Keyboard shortcuts') && txt.includes('⌘K'));
  console.log('PROVIDERS SECTION:', txt.includes('Hermes Agent'));
  await page.screenshot({ path: '/tmp/gaunt-settings-v2.png' });
  await browser.close();
};
void run();
