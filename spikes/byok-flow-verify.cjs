/* Verify the rebuilt BYOK connect flow end-to-end in the live app. */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 120000);
const SHOT_DIR = process.env.HOME + '/Desktop/clockwork-byok-audit';

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
    await page.locator('text=API providers').scrollIntoViewIfNeeded();

    // Open the new flow
    await page.click('[data-testid="connect-provider-btn"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: SHOT_DIR + '/10-flow-step1.png' });

    // Stage 1: pick DeepSeek card
    await page.click('[data-testid="provider-card-deepseek"]', { timeout: 4000 });
    await page.waitForTimeout(400);
    const keyVisible = await page.locator('[data-testid="api-key-input"]').isVisible();
    console.log('STEP2_KEY_FIELD_VISIBLE:', keyVisible);
    await page.screenshot({ path: SHOT_DIR + '/11-flow-step2.png' });

    // Paste a bogus key and continue
    await page.fill('[data-testid="api-key-input"]', 'sk-bogus-key-1234567890');
    await page.click('[data-testid="credentials-next"]', { timeout: 4000 });
    await page.waitForTimeout(300);

    // Stage 3: model selector + test connection
    const hasSelector = await page.locator('[data-testid="model-selector-trigger"]').isVisible();
    console.log('STEP3_MODEL_SELECTOR:', hasSelector);
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForTimeout(350);
    await page.screenshot({ path: SHOT_DIR + '/12-model-selector.png' });
    await page.keyboard.type('chat');
    await page.waitForTimeout(250);
    await page.screenshot({ path: SHOT_DIR + '/13-model-search.png' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const selText = await page.locator('[data-testid="model-selector-trigger"]').innerText();
    console.log('SELECTED_MODEL_TEXT:', JSON.stringify(selText.trim().slice(0, 60)));

    // Test connection with the bogus key — must produce a FRIENDLY error, not raw HTTP
    await page.click('[data-testid="test-connection-btn"]', { timeout: 4000 });
    await page.waitForTimeout(4000);
    const errText = await page.locator('[data-testid="test-error"]').innerText().catch(() => '(no error shown)');
    console.log('FRIENDLY_ERROR_SHOWN:', errText.trim().slice(0, 140));
    const saveDisabled = await page.locator('[data-testid="save-provider-btn"]').isDisabled();
    console.log('SAVE_DISABLED_BEFORE_VALID_TEST:', saveDisabled);
    await page.screenshot({ path: SHOT_DIR + '/14-test-failed.png' });

    // Escape closes cleanly; no config should have been created
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // Confirm nothing persisted via API
    const cfgs = await page.evaluate(async (t) => {
      const r = await fetch('/byok', { headers: { Authorization: 'Bearer ' + t } });
      return (await r.json()).configs.length;
    }, token);
    console.log('CONFIGS_AFTER_ABORTED_FLOW:', cfgs);

    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
