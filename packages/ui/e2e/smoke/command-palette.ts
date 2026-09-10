/**
 * CI smoke (T1-13): the command palette opens on ⌘K, filters commands, and
 * Enter navigates — driven entirely by the keyboard, independent of any
 * booked task. Companion to book-run-report.ts; see tracks/TRACK-1-macos-trust.md.
 *
 * Exit code is the number of failed checks (0 = pass), same convention as
 * product-verify.ts.
 */
import { chromium } from 'playwright';
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

const run = async (): Promise<number> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  // Not 'networkidle': the app opens a long-lived fetch() for /events (SSE,
  // api.ts openEventStream) right after mount, so the network is never idle
  // and that wait condition times out. Wait for the persistent nav instead —
  // it renders on every screen and its mount means useGlobalShortcuts (the
  // ⌘K listener) is attached too.
  await page.goto(BASE, { waitUntil: 'load' });
  await page.getByRole('button', { name: '+ New task' }).waitFor({ state: 'visible', timeout: 15_000 });

  check('palette is closed on load', (await page.locator('.palette').count()) === 0);

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(400);
  const paletteOpened = (await page.locator('.palette').count()) > 0;
  check('⌘K mounts the command palette', paletteOpened);

  // The rest depends on the palette actually being on screen — a screen that
  // stopped mounting should fail this one check cleanly, not throw partway
  // through the next locator and hide behind a stack trace.
  if (paletteOpened) {
    await page.fill('[data-testid=palette-input]', 'inbox');
    await page.waitForTimeout(250);
    const items = await page.locator('[data-testid=palette-item]').allInnerTexts();
    check('filtering "inbox" narrows to the Inbox command', items.some((t) => t.includes('Open Inbox')), JSON.stringify(items));

    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    check('Enter runs the command and the Inbox screen mounts', (await page.locator('.inbox-layout').count()) > 0);
    check('palette closes after running a command', (await page.locator('.palette').count()) === 0);
  } else {
    check('filtering "inbox" narrows to the Inbox command', false, 'palette never opened');
    check('Enter runs the command and the Inbox screen mounts', false, 'palette never opened');
    check('palette closes after running a command', false, 'palette never opened');
  }

  await browser.close();
  console.log(failures === 0 ? '\nCOMMAND PALETTE: ALL CHECKS PASSED' : `\nCOMMAND PALETTE: ${failures} FAILURE(S)`);
  return failures;
};

run()
  .then((f) => process.exit(f === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
