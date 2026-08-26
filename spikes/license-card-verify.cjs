/* Verify LicenseCard renders + capability matrix + activate rejection path. */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 90000);

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    await page.click('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(600);
    await page.locator('text=Plan & license').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    console.log('STATE_TITLE:', await page.locator('[data-testid="license-state-title"]').innerText());
    console.log('TIER_CHIP:', await page.locator('[data-testid="license-tier-chip"]').innerText());

    // Capability matrix opens and lists features
    await page.click('[data-testid="capability-matrix-toggle"]');
    await page.waitForTimeout(400);
    const rows = await page.locator('[data-testid="capability-matrix-toggle"] ~ div .flex.items-center').count();
    console.log('MATRIX_ROWS:', rows);

    // Activate with garbage -> human-readable rejection (fail-closed build)
    await page.click('[data-testid="license-activate-open"]');
    await page.fill('[data-testid="license-key-input"]', 'garbage-license-attempt');
    await page.click('[data-testid="license-activate-btn"]');
    await page.waitForTimeout(800);
    console.log('ACTIVATE_MSG:', (await page.locator('[data-testid="license-msg"]').innerText()).slice(0, 90));
    await page.screenshot({ path: process.env.HOME + '/Desktop/clockwork-byok-audit/20-license-card.png' });

    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
