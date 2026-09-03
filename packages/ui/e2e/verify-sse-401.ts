/* A rejected credential must not be retried forever. */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4848';
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  let attempts = 0;
  page.on('request', (r) => { if (r.url().includes('/events')) attempts++; });
  await page.addInitScript(() => localStorage.setItem('clockwork.token', 'definitely-not-a-valid-token'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  console.log('EVENTS_ATTEMPTS_IN_12S:', attempts);
  console.log('STOPPED_RETRYING:', attempts <= 2);
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
