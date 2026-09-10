/**
 * CI smoke (T1-13 pattern, promoted from spikes/a11y-audit.cjs for T4-10):
 * accessible names, label association, dialog semantics, and WCAG AA
 * contrast — swept across every tab the shell renders, not just Settings.
 *
 * Ported rather than left in spikes/, and rewritten, because the original
 * never asserted anything: it printed BUTTONS_WITHOUT_NAME / ORPHAN_FORM_
 * FIELDS / CONTRAST and exited 0 regardless of what it found — a check that
 * cannot fail is decoration. One of its own checks was itself decoration in
 * a second way: every orphan-field query was scoped to `.settings-view`, a
 * class that no longer exists anywhere in the app (SettingsView.tsx uses
 * `.settings-page` now), so the query always matched zero elements and
 * always "passed" no matter what the form looked like.
 *
 * Run AFTER book-run-report.ts in CI so Tasks/Inbox hold a real row, not
 * just an empty state.
 *
 * Exit code is the number of failed checks (0 = pass), same convention as
 * book-run-report.ts / command-palette.ts.
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

const TABS: Array<{ hash: string; label: string }> = [
  { hash: 'calendar', label: 'Calendar' },
  { hash: 'inbox', label: 'Inbox' },
  { hash: 'tasks', label: 'Tasks' },
  { hash: 'agents', label: 'Agents' },
  { hash: 'analytics', label: 'Analytics' },
  { hash: 'new', label: 'Composer' },
  { hash: 'settings', label: 'Settings' },
];

/**
 * Accessible-name scan for every VISIBLE button on the current page.
 *
 * A `<label for>` counts as naming a button. Native HTML label association
 * reaches the `button` element too, and Radix's `<Switch>` renders
 * `role="switch"` on a bare `<button>` with no text — ComposerView.tsx names
 * both of its switches (`c-telegram-group`, `c-slack`) entirely through
 * `<Label htmlFor>`. Verified against the live app before trusting this:
 * `page.getByRole('switch', { name: 'Post to Slack' })` resolves that
 * button, so Chromium's own accessible-name computation honours the label.
 * The naive textContent/aria-label/title check the original spike used
 * would have flagged both switches as false positives.
 */
async function unnamedButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement && b.offsetParent !== null)
      .filter((b) => {
        if ((b.textContent || '').trim()) return false;
        if (b.getAttribute('aria-label') || b.getAttribute('aria-labelledby')) return false;
        if (b.getAttribute('title')) return false;
        const id = b.id;
        if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
        if (b.closest('label')) return false;
        return true;
      })
      .map((b) => b.outerHTML.slice(0, 160)),
  );
}

/** Text/select fields under `main` with no accessible name — every tab, not just Settings. */
async function orphanFormFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    document
      .querySelectorAll('main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main select')
      .forEach((el) => {
        const id = (el as HTMLElement).id;
        const hasLabel = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const wrapped = el.closest('label');
        const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!hasLabel && !wrapped && !aria) {
          out.push(el.tagName + '.' + String((el as HTMLElement).className).slice(0, 40));
        }
      });
    return out;
  });
}

/**
 * WCAG AA (4.5:1) text-contrast check for the app's dim-text classes,
 * wherever they render.
 *
 * Deliberately declares NO named function anywhere inside the
 * `page.evaluate` closure — not a `function` declaration, not a named
 * `const fn = (...) => ...`, not even one whose body is trivial. `tsx`
 * transpiles this file with esbuild, which injects a `__name(fn, "fn")` call
 * to preserve `Function.prototype.name` on every named binding — but
 * `page.evaluate` serializes the closure's SOURCE TEXT and re-parses it
 * inside the browser, where `__name` was never defined, so ANY named
 * function in here throws `ReferenceError: __name is not defined` at
 * evaluation time. Confirmed empirically (not just in this file): a function
 * declaration and a named const-arrow both fail the same way, with or
 * without a TS return-type annotation; only an anonymous arrow passed
 * directly as a callback argument (`.map((v) => ...)`, no intermediate
 * identifier) survives. The luminance formula below is therefore inlined
 * per channel via `.reduce()` with an anonymous callback, twice, rather than
 * factored into a `luminance(rgb)` helper.
 */
async function contrastFailures(page: Page): Promise<Array<{ sel: string; ratio: number }>> {
  return page.evaluate(() => {
    const out: Array<{ sel: string; ratio: number }> = [];
    document.querySelectorAll('.section-title, .hint, .text-dim').forEach((el) => {
      // WCAG 1.4.3 (4.5:1) governs TEXT contrast. `.text-dim` is also used on
      // icon-wrapper spans that carry an SVG glyph and no text node at all
      // (e.g. ComposerView.tsx's section-header badges) — those are subject
      // to the separate, lower 1.4.11 non-text threshold (3:1), and mixing
      // them into this check would over-report. `own text` deliberately
      // excludes descendant text so a wrapper around a labelled child isn't
      // double-counted against the child's own contrast.
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim());
      if (!ownText) return;
      const fgMatch = getComputedStyle(el).color.match(/\d+/g);
      if (!fgMatch) return;
      let bgEl: Element | null = el;
      let bgColor = 'rgb(255, 255, 255)';
      while (bgEl && bgEl !== document.documentElement) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && !c.includes('0, 0, 0, 0') && c !== 'transparent') { bgColor = c; break; }
        bgEl = bgEl.parentElement;
      }
      const bgMatch = bgColor.match(/\d+/g);
      if (!bgMatch) return;
      const [fg, bg] = [fgMatch.slice(0, 3).map(Number), bgMatch.slice(0, 3).map(Number)];
      const weights = [0.2126, 0.7152, 0.0722];
      const fgLum = fg.reduce((sum: number, v: number, i: number) => {
        const c = v / 255;
        return sum + weights[i] * (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      }, 0);
      const bgLum = bg.reduce((sum: number, v: number, i: number) => {
        const c = v / 255;
        return sum + weights[i] * (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      }, 0);
      const [hi, lo] = [fgLum, bgLum].sort((x, y) => y - x);
      const r = +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
      if (r < 4.5) out.push({ sel: (el.className || el.tagName).toString().slice(0, 60), ratio: r });
    });
    return out;
  });
}

const run = async (): Promise<number> => {
  const browser = await chromium.launch(); // bundled Chromium only — CI installs no `channel`
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.getByRole('button', { name: '+ New task' }).waitFor({ state: 'visible', timeout: 15_000 });

  // ---- sweep every tab: accessible names, orphan fields, contrast ----
  for (const t of TABS) {
    await page.evaluate((h) => { window.location.hash = `#/${h}`; }, t.hash);
    await page.waitForTimeout(600);

    // Two surfaces need one extra nudge to expose controls a plain nav
    // wouldn't reach — skipping them would mean silently not auditing them.
    if (t.hash === 'tasks') {
      // Finished starts collapsed by design (T4-5) — its row actions live
      // behind the toggle. GET /tasks is async, so wait for the list to
      // actually settle (toggle present, or genuinely empty) rather than a
      // fixed sleep — a flat 600ms here intermittently ran before the toggle
      // existed and silently skipped the whole overflow-menu sweep below.
      const toggle = page.locator('[data-testid="tasks-finished-toggle"]');
      await Promise.race([
        toggle.waitFor({ state: 'attached', timeout: 5_000 }),
        page.locator('.empty').waitFor({ state: 'attached', timeout: 5_000 }),
      ]).catch(() => {});
      if (await toggle.count()) await toggle.click();
      await page.waitForTimeout(200);
    }
    if (t.hash === 'new') {
      // The "group chat" switch only renders once a Telegram chat id is
      // entered (ComposerView.tsx) — fill it so that control is in the sweep.
      const chatId = page.locator('#c-telegram-chat');
      if (await chatId.count()) await chatId.fill('123456789');
      await page.waitForTimeout(200);
    }

    const unnamed = await unnamedButtons(page);
    check(`${t.label}: every visible button has an accessible name`, unnamed.length === 0, JSON.stringify(unnamed));

    const orphans = await orphanFormFields(page);
    check(`${t.label}: every text/select field is labelled`, orphans.length === 0, JSON.stringify(orphans));

    const contrastFails = await contrastFailures(page);
    check(`${t.label}: dim text clears WCAG AA (4.5:1)`, contrastFails.length === 0, JSON.stringify(contrastFails));
  }

  // ---- Tasks overflow menu: named trigger, real menu semantics (T4-5) ----
  // TasksView unmounts (and its `finishedOpen` state resets) every time the
  // sweep above left the Tasks tab, so Finished has to be re-expanded here.
  await page.evaluate(() => { window.location.hash = '#/tasks'; });
  const reopenToggle = page.locator('[data-testid="tasks-finished-toggle"]');
  await Promise.race([
    reopenToggle.waitFor({ state: 'attached', timeout: 5_000 }),
    page.locator('.empty').waitFor({ state: 'attached', timeout: 5_000 }),
  ]).catch(() => {});
  if (await reopenToggle.count()) await reopenToggle.click();
  await page.waitForTimeout(200);
  const menuTrigger = page.locator('[data-testid="row-menu-trigger"]').first();
  const hasTaskRow = (await menuTrigger.count()) > 0;
  check('Tasks: at least one row to check the overflow menu on', hasTaskRow, hasTaskRow ? '' : 'no task rows — did book-run-report.ts run first?');
  if (hasTaskRow) {
    await menuTrigger.click();
    await page.waitForTimeout(200);
    const panel = page.locator('[data-testid="row-menu-panel"]');
    check('Tasks: overflow menu opens with role="menu"', (await panel.getAttribute('role')) === 'menu');
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="row-menu-panel"] [role="menuitem"]')].map((b) => ({
        text: (b.textContent || '').trim(),
        named: Boolean((b.textContent || '').trim() || b.getAttribute('aria-label')),
      })),
    );
    check('Tasks: overflow menu has at least one item', items.length > 0, JSON.stringify(items));
    check('Tasks: every overflow menu item is named', items.every((i) => i.named), JSON.stringify(items));
    await page.keyboard.press('Escape');
  }

  // ---- Settings: connect-provider dialog semantics (original spike check) ----
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  const connectBtn = page.locator('[data-testid="connect-provider-btn"]');
  // Settings loads its provider/capabilities data async — poll for the
  // control rather than a fixed sleep, which intermittently ran first.
  await connectBtn.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
  const hasConnectBtn = (await connectBtn.count()) > 0;
  check('Settings: "Connect a provider" control is present', hasConnectBtn);
  if (hasConnectBtn) {
    await connectBtn.first().click();
    await page.waitForTimeout(400);
    const dlgSemantics = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="provider-connect-flow"]')?.closest('[role="dialog"], dialog');
      if (!d) return null;
      const labelledby = d.getAttribute('aria-labelledby');
      const name = d.getAttribute('aria-label') ?? (labelledby ? (document.getElementById(labelledby)?.textContent ?? null) : null);
      return { role: d.getAttribute('role') ?? (d.tagName === 'DIALOG' ? 'dialog' : null), name };
    });
    check('Settings: connect-provider dialog exposes role="dialog"', dlgSemantics?.role === 'dialog', JSON.stringify(dlgSemantics));
    check('Settings: connect-provider dialog has an accessible name', Boolean(dlgSemantics?.name?.trim()), JSON.stringify(dlgSemantics));
    await page.keyboard.press('Escape');
  }

  await browser.close();
  console.log(failures === 0 ? '\nA11Y AUDIT: ALL CHECKS PASSED' : `\nA11Y AUDIT: ${failures} FAILURE(S)`);
  return failures;
};

run()
  .then((f) => process.exit(f === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
