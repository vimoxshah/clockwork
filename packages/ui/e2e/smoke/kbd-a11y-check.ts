/**
 * CI smoke (T1-13 pattern, promoted from spikes/kbd-a11y-check.cjs for
 * T4-10): keyboard-only paths through ProviderConnectFlow + ModelSelector,
 * plus a completeness sweep — every tab in the shell must be reachable by
 * its own Cmd-key shortcut, which is T4-10's actual "Done when".
 *
 * Ported and rewritten for the same reason as a11y-audit.ts: the original
 * printed six booleans/strings (FOCUS_TRAPPED_IN_DIALOG_ON_OPEN,
 * KEYBOARD_REACHED_STAGE3, ...) and exited 0 no matter what they were.
 *
 * Exit code is the number of failed checks (0 = pass).
 */
import { chromium, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4747';
const DATA_DIR = process.env.CLOCKWORK_HOME ?? `${homedir()}/.clockwork`;
const TOKEN = readFileSync(`${DATA_DIR}/api-token`, 'utf8').trim();

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const currentTabLabel = (page: Page): Promise<string | null> =>
  page.evaluate(
    () => document.querySelector('nav[aria-label="Sections"] button[aria-current="page"]')?.textContent?.trim() ?? null,
  );

const run = async (): Promise<number> => {
  const browser = await chromium.launch(); // bundled Chromium only — CI installs no `channel`
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.getByRole('button', { name: '+ New task' }).waitFor({ state: 'visible', timeout: 15_000 });

  // ---- every tab reachable by its own shortcut (T4-10 "Done when") ----
  const SHORTCUTS: Array<{ combo: string; label: string; hash: string }> = [
    { combo: 'Meta+1', label: 'Calendar', hash: '#/calendar' },
    { combo: 'Meta+2', label: 'Inbox', hash: '#/inbox' },
    { combo: 'Meta+3', label: 'Tasks', hash: '#/tasks' },
    { combo: 'Meta+4', label: 'Agents', hash: '#/agents' },
    { combo: 'Meta+5', label: 'Analytics', hash: '#/analytics' },
  ];
  for (const s of SHORTCUTS) {
    // Start from a neutral tab each time so the press has to do real work
    // instead of finding the target already active.
    await page.evaluate(() => { window.location.hash = '#/settings'; });
    await page.waitForTimeout(250);
    await page.keyboard.press(s.combo);
    await page.waitForTimeout(300);
    const label = await currentTabLabel(page);
    check(`${s.combo} reaches ${s.label}`, label === s.label, `nav shows ${JSON.stringify(label)}`);
    const hash = await page.evaluate(() => window.location.hash);
    check(`${s.combo} updates the URL hash to ${s.hash}`, hash === s.hash, hash);
  }

  // ---- ProviderConnectFlow + ModelSelector: keyboard-only path ----
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await page.waitForTimeout(300);
  // `text=API providers` is a SUBSTRING match, and the empty state right below
  // this heading reads "No API providers connected yet" — so it resolved to two
  // elements and Playwright's strict mode threw. It only broke once BYOK had no
  // provider connected, which is exactly the state CI runs in.
  //
  // `#byok-providers` is the heading's own id AND the `anchorId` two feature
  // surfaces are registered against (SettingsView.tsx:32,35), so
  // workforce-settings.test.tsx already fails if it stops rendering. Anchoring
  // here borrows a contract the app maintains instead of matching on prose.
  await page.locator('#byok-providers').scrollIntoViewIfNeeded();
  await page.click('[data-testid="connect-provider-btn"]');
  await page.waitForTimeout(400);

  const focusInDialog = await page.evaluate(() =>
    document.querySelector('[data-testid="provider-connect-flow"]')?.contains(document.activeElement),
  );
  check('focus lands inside the dialog on open', focusInDialog === true);

  const firstCard = page.locator('[data-testid="provider-card-anthropic"]');
  await firstCard.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const keyFocused = await page.evaluate(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'API key' ||
      document.querySelector('[data-testid="api-key-input"]') === document.activeElement,
  );
  check('Enter on a provider card auto-focuses the API key field', keyFocused === true);

  await page.fill('[data-testid="api-key-input"]', 'sk-test-1234567890');
  await page.keyboard.press('Tab'); // past the show/hide toggle
  const nextEnabled = await page.locator('[data-testid="credentials-next"]').isEnabled();
  check('"Next" enables once a key is entered', nextEnabled);
  await page.locator('[data-testid="credentials-next"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const stage3 = await page.locator('[data-testid="model-selector-trigger"]').isVisible();
  check('keyboard activation of "Next" reaches the model stage', stage3);

  // Captured BEFORE opening the popover: the trigger's placeholder text
  // ("Choose a model…") is itself non-empty, so asserting only that the
  // post-selection text is non-empty would pass even if ArrowDown/Enter did
  // nothing at all — the change is the thing being tested, not the presence.
  const beforeSelection = (await page.locator('[data-testid="model-selector-trigger"]').innerText()).trim();
  await page.click('[data-testid="model-selector-trigger"]');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const selected = (await page.locator('[data-testid="model-selector-trigger"]').innerText()).trim().split('\n')[0];
  check('ArrowDown x2 + Enter selects a model from the list', selected.length > 0 && selected !== beforeSelection, `before=${JSON.stringify(beforeSelection)} after=${JSON.stringify(selected)}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const popoverGone = (await page.locator('[aria-label="Search models"]').count()) === 0;
  check('Escape closes the model popover', popoverGone);
  await page.keyboard.press('Escape'); // close the connect dialog too — tidy state for whatever runs next

  await browser.close();
  console.log(failures === 0 ? '\nKEYBOARD A11Y: ALL CHECKS PASSED' : `\nKEYBOARD A11Y: ${failures} FAILURE(S)`);
  return failures;
};

run()
  .then((f) => process.exit(f === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
