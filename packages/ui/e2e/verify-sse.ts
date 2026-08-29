/* The fetch-based event stream must actually deliver events in a browser,
   and must never put the token in a URL. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.CW_BASE || 'http://127.0.0.1:4848';
const TOKEN = readFileSync(process.env.CW_TOKEN_FILE!, 'utf8').trim();

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();

  const urls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/events')) urls.push(r.url()); });

  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.addInitScript(() => {
    (window as any).__sse = [];
    window.addEventListener('clockwork:sse', (e) => (window as any).__sse.push((e as CustomEvent).detail));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const got = await page.evaluate(() => (window as any).__sse ?? []);
  const authHeaderSeen = await page.evaluate(() => true);
  void authHeaderSeen;

  console.log('EVENTS_RECEIVED:', JSON.stringify(got).slice(0, 200));
  console.log('EVENT_COUNT:', got.length);
  console.log('EVENTS_URLS:', JSON.stringify(urls));
  console.log('TOKEN_IN_ANY_URL:', urls.some((u) => u.includes(TOKEN)));
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
