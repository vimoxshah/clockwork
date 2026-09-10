/**
 * CI smoke (T1-13): book a one-off task from the composer, let the real
 * scheduler pick it up on its next sweep and the mock engine run it to a
 * terminal state, then open its report. This is the click-through class of
 * bug the daemon-boot-only smoke never caught — see tracks/TRACK-1-macos-trust.md.
 *
 * CI-safe by construction: the daemon must be started with CW_ENGINE=mock
 * (packages/daemon/src/runner-child.ts:125) so no real provider CLI or spend
 * is involved, and CW_MOCK_STEP_MS so the run is observable instead of
 * instantaneous. No network calls beyond the locally served app.
 *
 * Exit code is the number of failed checks (0 = pass), same convention as
 * product-verify.ts.
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

/**
 * Poll for the booked task's run to show up completed in the Inbox.
 *
 * The live path is SSE (api.ts openEventStream bumps a dataVersion that
 * InboxView refetches on) and is usually enough on its own, but it is a
 * push — a single dropped/delayed event stalls the wait for the rest of the
 * budget even though the daemon finished the run seconds ago (observed
 * locally). Every 15s without a hit, force a real reload: a fresh GET
 * /runs is a source-of-truth check that does not depend on the push having
 * arrived, so a missed SSE event costs at most one poll interval, not the
 * whole timeout.
 */
async function waitForCompletedRun(page: Page, taskName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const row = page.locator('[data-testid="run-completed"]', { hasText: taskName });
  let sinceReload = 0;
  while (Date.now() < deadline) {
    if ((await row.count()) > 0) return true;
    await page.waitForTimeout(3_000);
    sinceReload += 3_000;
    if (sinceReload >= 15_000) {
      sinceReload = 0;
      await page.reload({ waitUntil: 'load' });
      await page.getByRole('button', { name: '+ New task' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: 'Inbox', exact: true }).first().click();
    }
  }
  return (await row.count()) > 0;
}

const run = async (): Promise<number> => {
  // Unique per run: a stale completed row from an earlier session would
  // otherwise satisfy the terminal-state wait instantly and hide a real break.
  const taskName = `E2E smoke ${Date.now()}`;

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  // Not 'networkidle': the app opens a long-lived fetch() for /events (SSE,
  // api.ts openEventStream) right after mount, so the network is never idle
  // and that wait condition times out. Wait for the persistent nav instead.
  await page.goto(BASE, { waitUntil: 'load' });
  await page.getByRole('button', { name: '+ New task' }).waitFor({ state: 'visible', timeout: 15_000 });

  // ---- book a task (ASAP queue mode) ----
  await page.getByRole('button', { name: '+ New task' }).click();
  await page.waitForTimeout(400);
  await page.fill('#c-name', taskName);
  await page.fill('#c-prompt', 'Reply with exactly: E2E-OK');
  await page.fill('#c-usd', '1');
  await page.getByRole('tab', { name: 'ASAP' }).last().click();
  await page.getByRole('button', { name: 'Book it' }).click();
  await page.waitForTimeout(800);
  check('booking produced no composer error', (await page.locator('[data-testid="composer-error"]').count()) === 0);

  // ---- watch it reach a terminal state ----
  // The ASAP lead (ComposerView.tsx ASAP_LEAD_MS) plus the scheduler's 30s
  // sweep (scheduler.ts start()) means a real wait of up to ~45s is expected
  // here — that IS the pipeline this check exists to prove is wired.
  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click();
  const reachedTerminal = await waitForCompletedRun(page, taskName, 90_000);
  check('booked task reaches a completed run', reachedTerminal, reachedTerminal ? '' : 'timed out after 90s waiting for [data-testid=run-completed]');
  const completedRow = page.locator('[data-testid="run-completed"]', { hasText: taskName });

  // ---- open its report ----
  if (reachedTerminal) {
    await completedRow.first().click();
    await page.waitForTimeout(400);
    const heading = await page.locator('.report h2').innerText().catch(() => '');
    check('report opens with the task name as its heading', heading === taskName, heading);
    const summary = await page.locator('.report .summary-block').innerText().catch(() => '');
    check('report shows the mock engine\'s summary', summary.includes('Mock run completed'), summary.slice(0, 120));
  } else {
    check('report opens with the task name as its heading', false, 'no completed run to open');
    check("report shows the mock engine's summary", false, 'no completed run to open');
  }

  await browser.close();
  console.log(failures === 0 ? '\nBOOK/RUN/REPORT: ALL CHECKS PASSED' : `\nBOOK/RUN/REPORT: ${failures} FAILURE(S)`);
  return failures;
};

run()
  .then((f) => process.exit(f === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
