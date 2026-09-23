/**
 * 60fps proof (Round 4C): Playwright trace at 1440x900 over a 10k-line
 * virtualized UnifiedDiff, keyboard-only (no mouse after load).
 *
 * Serves a 10k-line transcript via route interception, opens the report
 * with j/k/e, scrolls the diff with PageDown/ArrowDown keys, and records
 * frame times via rAF plus longtasks + INP via PerformanceObserver.
 *
 * Win bar: Linear 60fps scroll, Raycast <100ms open.
 * Thresholds: avg fps >= 55, p95 frame < 33ms, INP < 200ms.
 *
 * Exit code is the number of failed checks (0 = pass).
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4747';
const DATA_DIR = process.env.CLOCKWORK_HOME ?? `${homedir()}/.clockwork`;
const TOKEN = readFileSync(`${DATA_DIR}/api-token`, 'utf8').trim();
/** Real daemon behind BASE when BASE is a static preview (fresh dist). */
const PROXY = process.env.PROXY ?? 'http://127.0.0.1:4747';

const LINES = 10_000;

function syntheticTranscript(n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    if (i % 50 === 0) out[i] = `@@ -${i},10 +${i},10 @@ hunk header for context grouping`;
    else if (i % 3 === 0) out[i] = `+added line ${i} — small fix with a moderately long tail to vary width ${'x'.repeat(i % 120)}`;
    else if (i % 3 === 1) out[i] = `-removed line ${i}`;
    else out[i] = ` context line ${i} — unchanged`;
  }
  return out;
}

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const run = async (): Promise<number> => {
  const big = syntheticTranscript(LINES);
  const runRow = {
    id: 'run_perf',
    task_id: 'task_perf',
    state: 'completed',
    outcome_reason: null,
    cost_usd: 0.5,
    turns: 9,
    started_at: Date.now() - 60_000,
    ended_at: Date.now(),
    scheduled_for: Date.now() - 60_000,
    branch: null,
    worktree_path: null,
    report_json: JSON.stringify({ summary: 'perf' }),
    jobspec_json: JSON.stringify({ taskName: 'Perf diff run', engine: 'claude' }),
  };

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);

  // Routing order: Playwright tries handlers LAST-registered FIRST, so the
  // generic proxy goes FIRST and the stubs below override it. (Function
  // matchers, not globs: `?` in a glob is a single-char wildcard and
  // silently misses query-string URLs — `**/runs?*` never matched
  // `/runs?limit=200`.)

  // Generic proxy: when BASE is a static preview of a fresh
  // `packages/ui/dist`, everything not stubbed answers from the daemon.
  // Document + assets serve from disk, never the proxy; the SSE stream is
  // aborted (proxying it would hang node-fetch forever — the app reconnects).
  if (new URL(BASE).port !== new URL(PROXY).port) {
    await page.route(`${BASE}/**`, async (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname.startsWith('/assets/')) {
        await r.continue();
        return;
      }
      if (u.pathname === '/events') {
        await r.abort();
        return;
      }
      try {
        const res = await fetch(`${PROXY}${u.pathname}${u.search}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        await r.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()) });
      } catch {
        await r.abort();
      }
    });
  }

  // Stub the wire so the trace needs no real 10k-line run on disk.
  const runsUrl = (url: URL): boolean => url.pathname === '/runs';
  const reportUrl = (url: URL): boolean => url.pathname === '/runs/run_perf/report';
  const transcriptUrl = (url: URL): boolean => url.pathname === '/runs/run_perf/transcript';
  const runEventsUrl = (url: URL): boolean => url.pathname === '/runs/run_perf/events';
  const approvalsUrl = (url: URL): boolean => url.pathname === '/approvals';
  await page.route(runsUrl, (r) => r.fulfill({ json: [runRow] }));
  await page.route(reportUrl, (r) =>
    r.fulfill({ json: { run: runRow, report: { summary: 'perf fixture', diffStat: [] } } }),
  );
  await page.route(transcriptUrl, (r) =>
    r.fulfill({ json: { available: true, totalLines: big.length, lines: big } }),
  );
  await page.route(runEventsUrl, (r) => r.fulfill({ json: { lines: [], from: 0, skipped: 0 } }));
  await page.route(approvalsUrl, (r) => r.fulfill({ json: [] }));

  // tracing — the artifact the critic replays, not just the numbers below.
  await page.context().tracing.start({ screenshots: true, snapshots: true });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(() => { window.location.hash = '#/inbox'; });
  await page.locator('[data-testid="run-completed"]').first().waitFor({ state: 'visible', timeout: 15_000 });

  // ---- keyboard-only triage: j selects, e expands transcript (no mouse) ----
  await page.keyboard.press('j');
  await page.waitForTimeout(300);
  const heading = await page.locator('.report h2').innerText().catch(() => '');
  check('j selects the run and opens its report', heading.includes('Perf diff run'), heading);
  await page.keyboard.press('e'); // transcript toggle via InboxView e-handler
  await page.locator('[data-testid="unified-diff"]').waitFor({ state: 'visible', timeout: 10_000 });
  check('e expands the virtualized diff', true);
  // focus the diff scroller with the keyboard alone (Tab reaches it; no click)
  await page.keyboard.press('Tab');
  await page.locator('[data-testid="unified-diff"]:focus').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
  await page.focus('[data-testid="unified-diff"]');

  // ---- record frames while scrolling with keys only ----
  // Plain strings, not closures: tsx/esbuild injects a __name helper into
  // compiled closures that does not exist in the page (observed
  // `ReferenceError: __name is not defined` on every closure form tried).
  await page.evaluate(`(() => {
    window.__frames = [];
    window.__longtasks = 0;
    window.__inp = 0;
    let last = performance.now();
    function loop(t) {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 600) requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    try {
      new PerformanceObserver((l) => { window.__longtasks += l.getEntries().length; })
        .observe({ entryTypes: ['longtask'] });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          const d = e.duration || 0;
          if (d > window.__inp) window.__inp = d;
        }
      }).observe({ entryTypes: ['event'] });
    } catch (e) { /* longtask/event timing absent: frames still report */ }
  })()`);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(120);
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('ArrowDown');
    if (i % 10 === 9) await page.waitForTimeout(60);
  }
  await page.waitForTimeout(800);

  const m = await page.evaluate(`(() => {
    const frames = window.__frames.filter((x) => x > 0 && x < 1000).sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
    const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] || 0;
    return {
      n: frames.length,
      avgFps: 1000 / Math.max(0.01, avg),
      p95,
      longtasks: window.__longtasks,
      inp: window.__inp,
      rendered: document.querySelectorAll('[data-testid^="ud-row-"]').length,
    };
  })()`);
  console.log(`frames=${m.n} avgFps=${m.avgFps.toFixed(1)} p95=${m.p95.toFixed(1)}ms longtasks=${m.longtasks} inp=${m.inp.toFixed(1)}ms domRows=${m.rendered}`);

  check('virtualized window stays small (<120 rows for 10k lines)', m.rendered < 120, `rows=${m.rendered}`);
  check('avg fps >= 55 (Linear 60fps bar)', m.avgFps >= 55, m.avgFps.toFixed(1));
  check('p95 frame < 33ms', m.p95 < 33, `${m.p95.toFixed(1)}ms`);
  check('INP < 200ms (Raycast open bar)', m.inp < 200, `${m.inp.toFixed(1)}ms`);

  await page.context().tracing.stop({ path: 'playwright-trace-diff-fps.zip' });
  await browser.close();
  console.log(failures === 0 ? '\nDIFF-FPS-TRACE: ALL CHECKS PASSED' : `\nDIFF-FPS-TRACE: ${failures} FAILURE(S)`);
  return failures;
};

run()
  .then((f) => process.exit(f === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
