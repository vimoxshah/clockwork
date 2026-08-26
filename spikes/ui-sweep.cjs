/* Live-app audit sweep: real UI, real daemon, no printed secrets. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/clockwork-audit';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 300)));

  // First load sets localStorage token (app reads it at boot).
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log('=== BOOT BODY ===\n' + bodyText);

  // Nav items discovered from the sidebar/header.
  const navs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nav a, aside a, [class*="nav"] a, button[class*="nav"]'))
      .map((a) => a.textContent.trim()).filter(Boolean).slice(0, 20));
  console.log('=== NAV ===\n' + JSON.stringify(navs));

  const views = ['Calendar', 'Inbox', 'Tasks', 'Agents', 'Analytics', 'Settings'];
  for (const v of views) {
    try {
      const link = page.locator(`text=${v}`).first();
      await link.click({ timeout: 4000 });
      await page.waitForTimeout(1200);
      const file = path.join(OUT, v.toLowerCase() + '.png');
      await page.screenshot({ path: file });
      const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 600));
      console.log(`\n=== ${v.toUpperCase()} ===\n` + txt);
    } catch (e) {
      console.log(`\n=== ${v.toUpperCase()} FAILED: ${String(e).slice(0, 200)}`);
    }
  }

  console.log('\n=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
  consoleErrors.slice(0, 10).forEach((e) => console.log('- ' + e));

  await browser.close();
})();
