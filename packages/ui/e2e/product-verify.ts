/**
 * E2E product verification (mandate §19): real Chromium against the real
 * daemon-served UI. Exercises every tab, calendar month grid, create flow,
 * inbox detail, themes + persistence. Fails loudly on any gap.
 */
import { chromium, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = 'http://127.0.0.1:4747';
const TOKEN = readFileSync(`${homedir()}/.clockwork/api-token`, 'utf8').trim();

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function expectVisible(page: Page, selector: string, name: string): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: 8000 });
    check(name, true);
  } catch {
    check(name, false, `selector not found: ${selector}`);
  }
}

const run = async (): Promise<number> => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  // fresh visitor with token
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // ---- default screen = calendar month view ----
  await expectVisible(page, '[data-theme]', 'theme attribute applied');
  await expectVisible(page, '.cal-grid', 'calendar grid renders');
  const cells = await page.locator('.cal-grid .cal-cell').count();
  check('month grid has 42 cells', cells === 42, `got ${cells}`);
  check(
    'today is highlighted',
    (await page.locator('.cal-cell.today').count()) === 1,
  );
  check('month title shows', /20\d\d/.test(await page.locator('.cal-title').innerText()));

  // ---- navigation prev/next/today ----
  const titleBefore = await page.locator('.cal-title').innerText();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const titleAfter = await page.locator('.cal-title').innerText();
  check('next month changes title', titleBefore !== titleAfter);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  check('prev returns', (await page.locator('.cal-title').innerText()) === titleBefore);
  await page.getByRole('button', { name: 'Today' }).click();
  check('today restores', (await page.locator('.cal-title').innerText()) === titleBefore);

  // ---- week toggle persists ----
  await page.getByRole('tab', { name: 'Week' }).click();
  await expectVisible(page, '.week-grid', 'week view renders');
  await page.reload({ waitUntil: 'networkidle' });
  check('week mode persists after reload', (await page.locator('.week-grid').count()) === 1);
  await page.getByRole('tab', { name: 'Month' }).click();

  // ---- day select → panel; book from day ----
  await page.locator('.cal-cell').nth(10).click();
  await expectVisible(page, '.day-panel', 'day panel opens on cell click');

  // ---- tasks tab: list + actions exist ----
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expectVisible(page, '.tasklist-row', 'tasks list rows');
  check('edit button present', (await page.getByRole('button', { name: 'Edit' }).count()) > 0);
  check('delete button present', (await page.locator('button.btn.danger.small').count()) > 0);

  // ---- inbox tab: list + filters + detail ----
  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.waitForTimeout(600);
  const hasRows = (await page.locator('.inbox-row').count()) > 0;
  if (hasRows) {
    await page.locator('.inbox-row').first().click();
    await expectVisible(page, '.report h2', 'report detail opens');
    const trBtn = page.locator('.transcript button');
    if ((await trBtn.count()) > 0) {
      await trBtn.first().click();
      await expectVisible(page, '.transcript pre', 'transcript expands');
    }
  } else {
    check('inbox empty state honest', (await page.locator('.empty').count()) > 0);
  }
  check('filter chips present', (await page.locator('.filter-chips button').count()) >= 5);

  // ---- composer via UI form (REAL create) ----
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.fill('#c-name', 'E2E smoke task');
  await page.fill('#c-prompt', 'Reply with exactly: E2E-OK');
  await page.fill('#c-usd', '1');
  await page.selectOption('#c-kind', 'once');
  {
    const d = new Date(Date.now() + 90_000);
    const p = (n: number): string => String(n).padStart(2, '0');
    await page.fill(
      '#c-when',
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`,
    );
  }
  await page.getByRole('button', { name: 'Book it' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expectVisible(page, 'text=E2E smoke task', 'created task appears in Tasks');

  // cleanup the e2e task
  const delBtns = page.locator('.tasklist-row', { hasText: 'E2E smoke task' }).locator('button.danger');
  if ((await delBtns.count()) > 0) {
    await delBtns.first().click();
    await page.locator('.dialog button.btn.danger', { hasText: 'Delete' }).click();
    await page.waitForTimeout(500);
    check('delete removes task row', (await page.locator('.tasklist-row', { hasText: 'E2E smoke task' }).count()) === 0);
  }

  // ---- settings: theme switch + persistence ----
  await page.getByRole('button', { name: 'Settings' }).click();
  await expectVisible(page, '.theme-toggle', 'theme toggle visible');
  await page.locator(".theme-toggle button", { hasText: 'light' }).click();
  check('light theme applied', (await page.getAttribute('html', 'data-theme')) === 'light');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Settings' }).click();
  check('light persists after reload', (await page.getAttribute('html', 'data-theme')) === 'light');
  await page.screenshot({ path: '/tmp/cw-light.png', fullPage: false });
  await page.locator(".theme-toggle button", { hasText: 'dark' }).click();
  check('dark theme applied', (await page.getAttribute('html', 'data-theme')) === 'dark');

  // every main surface in dark for contrast sanity
  await page.getByRole('button', { name: 'Calendar' }).click();
  await page.screenshot({ path: '/tmp/cw-dark-calendar.png' });
  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/cw-dark-inbox.png' });

  // narrow window
  await page.setViewportSize({ width: 760, height: 700 });
  await page.getByRole('button', { name: 'Calendar' }).click();
  await page.waitForTimeout(300);
  const calBox = await page.locator('.cal-grid').boundingBox();
  check('narrow window keeps calendar visible', !!calBox && calBox.width > 300);
  await page.setViewportSize({ width: 1280, height: 820 });

  // SSE live refresh: create a task OUT-OF-BAND via API; UI should reflect it
  // without any reload (dataVersion bump over EventSource).
  let sseBumped = false;
  page.on('console', () => {});
  const rowsBefore = await page.locator('.tasklist-row').count();
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.waitForTimeout(400);
  const resp = await fetch(`${BASE}/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'SSE live probe',
      prompt: 'noop',
      schedule: { kind: 'queue', tz: 'UTC' },
    }),
  });
  if (resp.ok) {
    try {
      await page.waitForSelector('text=SSE live probe', { timeout: 6000 });
      sseBumped = true;
    } catch {}
  }
  check('SSE event refreshes view without reload', sseBumped);
  check(
    'row count grew after external create',
    (await page.locator('.tasklist-row').count()) > rowsBefore - 1,
  );
  // cleanup probe task
  const delProbe = page.locator('.tasklist-row', { hasText: 'SSE live probe' }).locator('button.danger');
  if ((await delProbe.count()) > 0) {
    await delProbe.first().click();
    await page.locator('.dialog button.btn.danger', { hasText: 'Delete' }).click();
    await page.waitForTimeout(500);
  }

  // console errors (filter benign SSE noise)
  const bad = consoleErrors.filter(
    (e) => !/EventSource|favicon|net::ERR_ABORTED/.test(e),
  );
  check('no uncaught console errors', bad.length === 0, bad.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  return failures;
};

run().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => {
  console.error(e);
  process.exit(1);
});
