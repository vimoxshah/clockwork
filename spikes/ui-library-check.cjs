/* Verify Agent Library: categories, search, featured ordering. */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('text=Agents');
  await page.waitForTimeout(1000);

  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button[aria-pressed]')).map((b) => b.textContent.trim()));
  console.log('CATEGORY CHIPS:', JSON.stringify(chips));

  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.agents-page strong')).map((s) => s.textContent.trim()));
  console.log('AGENT ORDER:', JSON.stringify(names.slice(0, 15)));

  // Search behavior
  await page.fill('input[aria-label="Search agent library"]', 'security');
  await page.waitForTimeout(400);
  const filtered = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.agents-page strong')).map((s) => s.textContent.trim()));
  console.log('SEARCH "security":', JSON.stringify(filtered));

  await page.screenshot({ path: '/tmp/clockwork-audit/agent-library.png', fullPage: true });

  // Footer version
  const footer = await page.evaluate(() => document.body.innerText.match(/daemon [\d.]+/)?.[0]);
  console.log('FOOTER:', footer);

  // No-match empty state
  await page.fill('input[aria-label="Search agent library"]', 'zzzznotfound');
  await page.waitForTimeout(300);
  const empty = await page.evaluate(() => document.body.innerText.includes('No agents match'));
  console.log('EMPTY STATE SHOWN:', empty);

  await browser.close();
})();
