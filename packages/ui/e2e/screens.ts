import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark'] as const) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 840 } })).newPage();
    await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
    await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
    await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `/tmp/cw-${theme}-calendar.png` });
    await page.getByRole('button', { name: '+ New task' }).click();
    await page.fill('#c-prompt', 'Summarize open TODOs and propose a fix order.');
    await page.locator('#c-when').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/tmp/cw-${theme}-composer-picker.png` });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `/tmp/cw-${theme}-composer.png` });
    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/cw-${theme}-inbox.png` });
    await page.context().close();
  }
  await browser.close();
  console.log('screenshots: /tmp/cw-{light,dark}-{calendar,composer,composer-picker,inbox}.png');
};
void run();
