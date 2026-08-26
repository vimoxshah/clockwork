/* Verify app boots cleanly under strict CSP across all views.
   SSE-safe: uses domcontentloaded + fixed settle instead of networkidle,
   which never fires while the daemon's SSE stream stays open.
   Watchdog-bounded so a hang can never wedge the calling session. */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => {
  console.error('WATCHDOG TIMEOUT (90s)');
  process.exit(2);
}, 90000);

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage();
    const violations = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) {
        violations.push(m.text().slice(0, 200));
      }
    });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200); // React mounts here; SSE stays open by design

    for (const v of ['Calendar', 'Inbox', 'Agents', 'Tasks', 'Analytics', 'Settings']) {
      try {
        await page.click(`text=${v}`, { timeout: 2500 });
        await page.waitForTimeout(350);
      } catch {
        console.log('NAV MISS:', v);
      }
    }

    // Same-origin fetch must keep working under connect-src 'self'
    const healthOk = await page.evaluate(async () => (await fetch('/health')).ok);

    console.log('HEALTH FETCH OK:', healthOk);
    console.log('CSP VIOLATIONS:', violations.length);
    violations.slice(0, 5).forEach((v) => console.log('-', v));
    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
