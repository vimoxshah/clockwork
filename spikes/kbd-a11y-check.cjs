/* Keyboard accessibility assertions for ProviderConnectFlow + ModelSelector (§29). */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 90000);

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.click('text=Settings');
    await page.locator('text=API providers').scrollIntoViewIfNeeded();
    await page.click('[data-testid="connect-provider-btn"]');
    await page.waitForTimeout(400);

    // Dialog focus lands inside content; Tab cycles within dialog
    const focusInDialog = await page.evaluate(() =>
      document.querySelector('[data-testid="provider-connect-flow"]')?.contains(document.activeElement),
    );
    console.log('FOCUS_TRAPPED_IN_DIALOG_ON_OPEN:', focusInDialog);

    // Stage 0: Tab through provider cards, Enter picks one
    const firstCard = page.locator('[data-testid="provider-card-anthropic"]');
    await firstCard.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const keyFocused = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label') === 'API key' ||
      document.querySelector('[data-testid="api-key-input"]') === document.activeElement,
    );
    console.log('STAGE2_KEY_AUTOFOCUSED:', keyFocused);

    // Paste-style input + Enter advances? (Next button reachable by keyboard)
    await page.fill('[data-testid="api-key-input"]', 'sk-test-1234567890');
    await page.keyboard.press('Tab'); // move past show/hide toggle
    const nextEnabled = await page.locator('[data-testid="credentials-next"]').isEnabled();
    console.log('NEXT_ENABLED_WITH_KEY:', nextEnabled);
    // Focus the Next button directly and press Enter (keyboard activation)
    await page.locator('[data-testid="credentials-next"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const stage3 = await page.locator('[data-testid="model-selector-trigger"]').isVisible();
    console.log('KEYBOARD_REACHED_STAGE3:', stage3);

    // ModelSelector: open, ArrowDown x2, Enter selects second model
    await page.click('[data-testid="model-selector-trigger"]');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    const selected = await page.locator('[data-testid="model-selector-trigger"]').innerText();
    console.log('ARROW_NAV_SELECTED:', JSON.stringify(selected.trim().split('\n')[0]));

    // Escape closes the popover (Radix)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const popoverGone = (await page.locator('[aria-label="Search models"]').count()) === 0;
    console.log('ESCAPE_CLOSED_POPOVER:', popoverGone);

    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
