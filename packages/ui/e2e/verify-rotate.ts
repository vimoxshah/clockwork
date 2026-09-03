/* Rotating from the UI must swap the stored token AND leave a working app. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4848';
const HOME = process.env.CW_HOME!;
const run = async (): Promise<void> => {
  const before = readFileSync(`${HOME}/api-token`, 'utf8').trim();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => { console.log('DIALOG:', d.type(), JSON.stringify(d.message()).slice(0, 120)); void d.accept(); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR:', m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.url().includes('/auth/rotate')) console.log('ROTATE_RESPONSE:', r.status()); });
  // Seed ONLY when empty: addInitScript re-runs on every navigation, so an
  // unconditional set would overwrite the rotated token on reload and make a
  // working rotation look broken. A real user's localStorage persists.
  await page.addInitScript((t) => {
    if (!localStorage.getItem('clockwork.token')) localStorage.setItem('clockwork.token', t);
  }, before);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(1200);

  await page.getByTestId('rotate-token').click();
  await page.waitForTimeout(3500);

  const stored = await page.evaluate(() => localStorage.getItem('clockwork.token'));
  const onDisk = readFileSync(`${HOME}/api-token`, 'utf8').trim();
  console.log('TOKEN_CHANGED:', onDisk !== before);
  console.log('UI_MATCHES_DISK:', stored === onDisk);

  // after reload the app must still be authenticated, not stuck on a 401 screen
  await page.waitForTimeout(1500);
  const authed = await page.evaluate(async () => {
    const r = await fetch('/profiles', {
      headers: { Authorization: `Bearer ${localStorage.getItem('clockwork.token')}` },
    });
    return r.status;
  });
  console.log('POST_ROTATE_PROFILES_STATUS:', authed);
  console.log('STILL_WORKS:', authed === 200);
  await browser.close();
};
run().catch((e) => { console.error(e.message); process.exit(1); });
