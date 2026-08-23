import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  // settings — find theme controls
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(800);
  const themeToggle = await page.locator('.theme-toggle').count();
  console.log('theme-toggle count:', themeToggle);
  if (themeToggle) {
    const btns = await page.locator('.theme-toggle button').allInnerTexts();
    console.log('THEME BUTTONS:', JSON.stringify(btns));
    const setAndCheck = async (label: string, attr: string): Promise<void> => {
      await page.locator('.theme-toggle button', { hasText: label }).click();
      await page.waitForTimeout(300);
      const got = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      console.log(`set ${label} -> data-theme=${got} (expect ${attr})`, got === attr ? 'OK' : 'FAIL');
    };
    await setAndCheck('dark', 'dark');
    await page.screenshot({ path: '/tmp/gaunt-dark-settings.png' });
    for (const tab of ['Calendar', 'Inbox']) {
      await page.getByRole('button', { name: tab, exact: true }).first().click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `/tmp/gaunt-dark-${tab.toLowerCase()}.png` });
      console.log(tab, 'data-theme still:', await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click(); await page.waitForTimeout(500); await setAndCheck('light', 'light');
    await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/gaunt-light-calendar.png' });
    // reload persistence
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    console.log('after reload:', await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
    // restore system
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.locator('.theme-toggle button', { hasText: 'system' }).click();
  }
  // narrow window overflow diagnosis
  await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForTimeout(600);
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: Array<{ sel: string; right: number; w: number }> = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 20) out.push({ sel: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`, right: Math.round(r.right), w: Math.round(r.width) });
    });
    return { vw, out: out.slice(0, 12) };
  });
  console.log('OVERFLOW at 760px:', JSON.stringify(wide, null, 1));
  await browser.close();
};
void run();
