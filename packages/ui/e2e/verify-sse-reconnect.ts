/* EventSource reconnected for free; the fetch stream reimplements it. Prove it.
   The daemon emits daemon.health on every new connection, so a successful
   reconnect shows up as a SECOND health event. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:4848';
const HOME = process.env.CW_HOME!;
const TOKEN = readFileSync(`${HOME}/api-token`, 'utf8').trim();

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.addInitScript(() => {
    (window as any).__sse = [];
    window.addEventListener('clockwork:sse', (e) => (window as any).__sse.push((e as CustomEvent).detail));
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const before = (await page.evaluate(() => (window as any).__sse.length)) as number;
  console.log('events before kill:', before);

  // kill the daemon
  try { execSync("pkill -f 'CLOCKWORK_PORT=4848' || pkill -f 'dist/main.js'", { stdio: 'ignore' }); } catch { /* */ }
  try { execSync(`lsof -ti :4848 | xargs kill 2>/dev/null`, { stdio: 'ignore' }); } catch { /* */ }
  await page.waitForTimeout(2500);
  console.log('daemon killed');

  // restart it
  const child = spawn('node', ['../daemon/dist/main.js'], {
    env: { ...process.env, CLOCKWORK_HOME: HOME, CLOCKWORK_PORT: '4848' },
    detached: true, stdio: 'ignore',
  });
  child.unref();

  // the client backs off up to 30s; give it room
  let after = before;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500);
    after = (await page.evaluate(() => (window as any).__sse.length)) as number;
    if (after > before) break;
  }
  console.log('events after restart:', after);
  console.log('RECONNECTED:', after > before);
  await browser.close();
  process.exit(after > before ? 0 : 1);
};
run().catch((e) => { console.error(e.message); process.exit(1); });
