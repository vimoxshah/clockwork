/* Drive Settings -> BYOK add-provider flow; capture screenshots + defects. */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 120000);
const SHOT_DIR = process.env.HOME + '/Desktop/clockwork-byok-audit';
fs.mkdirSync(SHOT_DIR, { recursive: true });

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    // Go to Settings
    await page.click('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(800);
    const byokSection = page.locator('text=API providers');
    await byokSection.scrollIntoViewIfNeeded();
    await page.screenshot({ path: SHOT_DIR + '/01-settings-byok.png', fullPage: false });

    // Open the add form
    await page.click('text=+ Add provider', { timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: SHOT_DIR + '/02-add-form-default.png' });

    // Switch provider kind to anthropic and capture
    const selects = page.locator('select');
    const count = await selects.count();
    console.log('NATIVE_SELECT_COUNT_IN_FORM:', count);
    if (count > 0) {
      await selects.first().selectOption({ label: 'Anthropic' }).catch(async () => {
        const opts = await selects.first().locator('option').allTextContents();
        console.log('PROVIDER_OPTIONS:', JSON.stringify(opts));
      });
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: SHOT_DIR + '/03-add-form-anthropic.png' });

    // Check the credential-source control
    const credSelect = page.locator('select[aria-label="Credential source"]');
    console.log('CRED_SOURCE_IS_SELECT:', (await credSelect.count()) > 0);

    // Count disabled radio buttons
    const radios = page.locator('input[type="radio"]');
    const rc = await radios.count();
    let disabled = 0;
    for (let i = 0; i < rc; i++) if (await radios.nth(i).isDisabled()) disabled++;
    console.log('RADIOS:', rc, 'DISABLED:', disabled);

    // Composer provider selector state
    await page.click('text=New task', { timeout: 3000 }).catch(() => {});
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    console.log('AUDIT DONE. Screenshots in', SHOT_DIR);
    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
