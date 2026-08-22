import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('response', async (r) => {
    if (r.status() >= 500) {
      let body = '';
      try { body = (await r.text()).slice(0, 200); } catch {}
      console.log(`500 ${r.url()}\n   body: ${body}`);
    }
  });
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  for (const tab of ['Inbox', 'Tasks', 'Settings']) {
    await page.getByRole('button', { name: tab }).click();
    await page.waitForTimeout(1200);
  }
  await browser.close();
};
void run();
