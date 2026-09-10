/**
 * The live run view (T4-1): watching a run work, from the Inbox.
 *
 * THE BUG THIS FILE EXISTS FOR, AND WHY IT SURVIVED
 *   `LiveTail` shipped, was mounted, and could not work. `App.tsx` bumps
 *   `dataVersion` on EVERY SSE frame; `useAsync` sets `loading = true` at the
 *   start of each refetch; and `ReportDetail` returned its spinner on a bare
 *   `detail.loading`. So the first `run.log` frame that arrived unmounted the
 *   component that was collecting the lines, and the tail reset to empty —
 *   once per line. Nothing caught it because there was no test anywhere in
 *   the repo for `run.log`, `LiveTail`, or the predicate that decides a run
 *   is still active.
 *
 *   `keeps the lines it has collected across a data-version bump` is that
 *   regression. It bumps the version exactly the way App.tsx does and waits
 *   for the refetch to actually land, so a component that unmounts on refetch
 *   fails it.
 *
 * The other half of the fix is `GET /runs/:id/events`: the stream only
 * carries what happens after you subscribe, so a tab opened mid-run used to
 * start blank. Here the seed and the stream are asserted together, since the
 * user-visible promise is one list of lines, oldest first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { isRunActive } from '../src/components/InboxView';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const render = renderComponent;
const now = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 1. Which runs are still going (pure)
// ---------------------------------------------------------------------------

describe('isRunActive', () => {
  it('counts a run that is paused on a human as still running', () => {
    // The whole point of surfacing approvals in this view: the run has not
    // stopped, it is waiting for you. Dropping these two would hide the tail
    // at the exact moment the user is being asked something.
    expect(isRunActive('waiting_approval')).toBe(true);
    expect(isRunActive('awaiting_user')).toBe(true);
  });

  it('covers the states that can still produce output', () => {
    for (const s of ['running', 'preparing', 'finalizing']) expect(isRunActive(s)).toBe(true);
  });

  it('excludes a booking with no child yet, and every terminal state', () => {
    // `queued` is deliberately absent: there is no process, so a live tail
    // would sit on "Waiting for output…" for ever. It IS in the "Active"
    // filter chip, which answers a different question.
    for (const s of ['queued', 'completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'missed']) {
      expect(isRunActive(s), `${s} must not claim to be live`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const runningRun = {
  id: 'run_live',
  task_id: 'task_live',
  state: 'running',
  outcome_reason: null,
  cost_usd: 0.42,
  turns: 7,
  started_at: now - 30_000,
  ended_at: null,
  scheduled_for: now - 30_000,
  branch: null,
  worktree_path: null,
  report_json: null,
  jobspec_json: JSON.stringify({ taskName: 'Refactor the parser', engine: 'claude' }),
};

interface StubOptions {
  seed?: Array<{ at: number; kind: string; text: string }>;
  seedFrom?: number;
  seedSkipped?: number;
  seedStatus?: number;
  approvals?: unknown[];
  run?: Record<string, unknown>;
  /** more than one row in the list, served by id from /runs/:id/report */
  runs?: Array<Record<string, unknown>>;
}

interface Stub {
  calls: string[];
  reportCalls: () => number;
}

function stubFetch(opts: StubOptions = {}): Stub {
  const run = opts.run ?? runningRun;
  const rows = opts.runs ?? [run];
  const calls: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('/runs?')) return json(rows);
    if (u === '/approvals') return json(opts.approvals ?? []);
    if (/^\/runs\/[^/]+\/events/.test(u)) {
      if (opts.seedStatus && opts.seedStatus !== 200) return json({ error: 'journal on fire' }, opts.seedStatus);
      const lines = opts.seed ?? [];
      return json({
        runId: run.id,
        since: 0,
        from: opts.seedFrom ?? 0,
        nextSince: lines.length * 40,
        lines,
        skipped: opts.seedSkipped ?? 0,
        complete: true,
      });
    }
    if (/^\/runs\/[^/]+\/report$/.test(u)) {
      // Deliberately not instant. A stub that resolves in the same microtask
      // as the request lets React batch `loading = true` together with the
      // answer, so the loading render never commits — and the remount bug
      // this file exists for becomes invisible. Verified: with the old
      // `if (detail.loading)` guard restored, the version-bump test below
      // passes without this delay and fails with it.
      await new Promise((r) => setTimeout(r, 15));
      const id = u.split('/')[2];
      return json({ run: rows.find((r) => r.id === id) ?? run, report: null });
    }
    if (/^\/runs\/[^/]+\/transcript$/.test(u)) return json({ available: false, lines: [] });
    if (/^\/workforce\/handoff\//.test(u)) return json({ memories: [] });
    if (/^\/workforce\/runs\/[^/]+\/proposed-events$/.test(u)) return json({ events: [] });
    throw new Error(`unexpected fetch in live-run-view test: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, reportCalls: () => calls.filter((c) => /^\/runs\/[^/]+\/report$/.test(c)).length };
}

/**
 * Stands in for App.tsx, which owns `dataVersion` and bumps it on every
 * single SSE frame. The bump is the thing under test in one case below, so
 * the harness has to reproduce it rather than render a fixed version.
 */
function InboxHarness({ Inbox }: { Inbox: (p: { version: number }) => JSX.Element }): JSX.Element {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setVersion((v) => v + 1);
    window.addEventListener('test:bump', bump);
    return () => window.removeEventListener('test:bump', bump);
  }, []);
  return <Inbox version={version} />;
}

/** Mount the inbox and open the run's report — where the live view lives. */
async function openRun(): Promise<HTMLDivElement> {
  const { default: InboxView } = await import('../src/components/InboxView');
  const container = await render(<InboxHarness Inbox={InboxView} />);
  const row = await waitForElement(container, '[data-testid="run-running"]');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await waitForElement(container, '[data-testid="live-tail"]');
  return container;
}

/** One coalesced `run.log` frame, exactly as the daemon puts it on the wire. */
function emitLog(runId: string, lines: string[], at = now): void {
  window.dispatchEvent(
    new CustomEvent('clockwork:sse', { detail: { type: 'run.log', runId, lines, at } }),
  );
}

/**
 * The rendered lines, without their timestamps. Each row is
 * `<div><span>{time} </span>{text}</div>`, and the time is formatted with the
 * host's `toLocaleTimeString` — so reading the second child node keeps these
 * assertions true under any ICU locale rather than pinning one.
 */
const tailLines = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll('[data-testid="live-tail-output"] > div')).map(
    (d) => d.childNodes[1]?.textContent ?? '',
  );

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 2. The tail
// ---------------------------------------------------------------------------

describe('the live tail', () => {
  it('seeds from the run journal, so a tab opened mid-run is not blank', async () => {
    stubFetch({
      seed: [
        { at: now - 20_000, kind: 'log', text: 'cloning the worktree' },
        { at: now - 10_000, kind: 'log', text: 'reading src/parser.ts' },
      ],
    });
    const container = await openRun();
    await waitForText(container, 'cloning the worktree');

    expect(tailLines(container).join('\n')).toContain('reading src/parser.ts');
  });

  it('appends the lines a coalesced run.log frame carries, in order, after the seed', async () => {
    stubFetch({ seed: [{ at: now - 20_000, kind: 'log', text: 'from before you looked' }] });
    const container = await openRun();
    await waitForText(container, 'from before you looked');

    emitLog('run_live', ['now editing', 'now testing']);
    await waitForText(container, 'now testing');

    expect(tailLines(container), 'the seam between journal and stream must read as one list').toEqual([
      'from before you looked',
      'now editing',
      'now testing',
    ]);
  });

  it('ignores frames for other runs', async () => {
    stubFetch();
    const container = await openRun();
    emitLog('run_somebody_else', ['not yours']);
    emitLog('run_live', ['yours']);
    await waitForText(container, 'yours');
    expect(container.textContent).not.toContain('not yours');
  });

  it('keeps the lines it has collected across a data-version bump', async () => {
    // THE REGRESSION. Every SSE frame bumps App.tsx's dataVersion, so if the
    // report view unmounts while refetching, the tail is wiped once per line
    // and the live view can never show more than the last frame.
    const stub = stubFetch({ seed: [{ at: now - 1000, kind: 'log', text: 'seeded line' }] });
    const container = await openRun();
    await waitForText(container, 'seeded line');
    emitLog('run_live', ['streamed line']);
    await waitForText(container, 'streamed line');

    const before = stub.reportCalls();
    window.dispatchEvent(new Event('test:bump'));
    // Prove the refetch really happened AND finished — otherwise this test
    // passes without ever entering the state that used to break it.
    await waitFor(() => stub.reportCalls() > before, 'the report to be refetched', {
      describe: () => `report calls = ${stub.reportCalls()} (was ${before})`,
    });
    await waitFor(
      () => container.querySelector('[data-testid="live-tail"]') !== null,
      'the live tail to still be mounted after the refetch',
      { describe: () => `report pane = ${container.querySelector('.report')?.textContent ?? '(none)'}` },
    );

    const text = tailLines(container).join('\n');
    expect(text, 'the seeded line was thrown away by the remount').toContain('seeded line');
    expect(text, 'the streamed line was thrown away by the remount').toContain('streamed line');
  });

  it('holds only the last 200 lines, and says the rest is elsewhere', async () => {
    stubFetch({ seed: [], seedFrom: 4096, seedSkipped: 12 });
    const container = await openRun();
    await waitForText(container, 'Showing the last 200 lines');

    emitLog('run_live', Array.from({ length: 250 }, (_, i) => `line ${i}`));
    await waitForText(container, 'line 249');

    const lines = tailLines(container);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain('line 50');
    expect(lines[199]).toContain('line 249');
  });

  it('says so when the catch-up read fails, instead of looking like a quiet run', async () => {
    stubFetch({ seedStatus: 500 });
    const container = await openRun();
    await waitForElement(container, '[data-testid="live-tail-seed-error"]');
    expect(container.textContent).toContain('Earlier output couldn’t be loaded');
    // …and the stream still works, because the subscription never depended
    // on the seed landing.
    emitLog('run_live', ['still streaming']);
    await waitForText(container, 'still streaming');
  });

  it('shows cost and turns beside the output', async () => {
    stubFetch();
    const container = await openRun();
    expect(container.querySelector('[data-testid="live-tail-cost"]')!.textContent).toBe('$0.4200');
    expect(container.querySelector('[data-testid="live-tail-turns"]')!.textContent).toBe('7 turns');
  });

  it('never shows one run’s report under another run’s id', async () => {
    // The cost of keeping stale data through a refetch (above) is that
    // switching runs would show the OLD report under the NEW selection.
    // `key={selected}` on ReportDetail is what pays it, and this is the
    // assertion that keeps it there.
    const other = {
      ...runningRun,
      id: 'run_other',
      state: 'completed',
      ended_at: now,
      jobspec_json: JSON.stringify({ taskName: 'Tidy the changelog', engine: 'claude' }),
    };
    stubFetch({ runs: [runningRun, other] });
    const container = await openRun();
    const pane = container.querySelector('.report') as HTMLElement;
    await waitForText(pane, 'Refactor the parser');

    const otherRow = container.querySelector('[data-testid="run-completed"]')!;
    otherRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The list marking the new row selected and the pane drawing its content
    // are the same React commit, so this is the race-free anchor: from the
    // moment the list says "run_other", the pane may not still say "run_live".
    await waitFor(() => otherRow.classList.contains('sel'), 'the new run to become the selected row', {
      describe: () => `row classes = ${otherRow.className}`,
    });
    expect(pane.textContent, 'the previous run’s report lingered under the newly selected run').not.toContain(
      'Refactor the parser',
    );
    await waitForText(pane, 'Tidy the changelog');
  });

  it('is not drawn at all for a run that has already finished', async () => {
    stubFetch({ run: { ...runningRun, state: 'completed', ended_at: now } });
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxHarness Inbox={InboxView} />);
    const row = await waitForElement(container, '[data-testid="run-completed"]');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForText(container, 'Refactor the parser');
    expect(container.querySelector('[data-testid="live-tail"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-scroll, and the pause that makes it usable
// ---------------------------------------------------------------------------

describe('auto-scroll', () => {
  /** jsdom has no layout, so the scroll geometry has to be stated. */
  function giveGeometry(el: Element, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }): void {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  }

  it('follows the newest line while the user is at the bottom', async () => {
    stubFetch();
    const container = await openRun();
    emitLog('run_live', ['one']);
    const pre = await waitForElement<HTMLPreElement>(container, '[data-testid="live-tail-output"]');
    giveGeometry(pre, { scrollHeight: 1000, clientHeight: 200 });

    emitLog('run_live', ['two']);
    await waitFor(() => pre.scrollTop === 1000, 'the tail to scroll to the newest line', {
      describe: () => `scrollTop = ${pre.scrollTop}`,
    });
    expect(container.querySelector('[data-testid="live-tail-follow"]'), 'nothing to resume — it never paused').toBeNull();
  });

  it('stops following the moment the user scrolls up, and offers the way back', async () => {
    stubFetch();
    const container = await openRun();
    emitLog('run_live', ['one']);
    const pre = await waitForElement<HTMLPreElement>(container, '[data-testid="live-tail-output"]');
    giveGeometry(pre, { scrollHeight: 1000, clientHeight: 200 });

    // The user drags the scrollbar up to read something.
    pre.scrollTop = 100;
    pre.dispatchEvent(new Event('scroll'));
    const follow = await waitForElement<HTMLButtonElement>(container, '[data-testid="live-tail-follow"]');
    expect(follow.textContent).toContain('Paused');

    // New output must NOT yank the view away from what they are reading.
    emitLog('run_live', ['two', 'three']);
    await waitForText(container, 'three');
    expect(pre.scrollTop, 'auto-scroll fought the user for the scrollbar').toBe(100);

    follow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => pre.scrollTop === 1000, 'the jump back to the newest line', {
      describe: () => `scrollTop = ${pre.scrollTop}`,
    });
    expect(container.querySelector('[data-testid="live-tail-follow"]'), 'following again, so nothing to resume').toBeNull();
  });

  it('resumes following on its own when the user scrolls back down', async () => {
    stubFetch();
    const container = await openRun();
    emitLog('run_live', ['one']);
    const pre = await waitForElement<HTMLPreElement>(container, '[data-testid="live-tail-output"]');
    giveGeometry(pre, { scrollHeight: 1000, clientHeight: 200 });
    pre.scrollTop = 100;
    pre.dispatchEvent(new Event('scroll'));
    await waitForElement(container, '[data-testid="live-tail-follow"]');

    pre.scrollTop = 800; // 1000 - 800 - 200 = 0px from the bottom
    pre.dispatchEvent(new Event('scroll'));
    await waitFor(
      () => container.querySelector('[data-testid="live-tail-follow"]') === null,
      'the pause notice to clear once the user is back at the bottom',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. "Waiting for you", where you are already looking
// ---------------------------------------------------------------------------

describe('an approval that arrives while you are watching', () => {
  const permissionApproval = {
    id: 'ap_live',
    run_id: 'run_live',
    kind: 'permission',
    payload_json: JSON.stringify({ tool: 'Bash', reqId: 'req_1' }),
    requested_at: now,
    timeout_at: now + 300_000,
    fallback: 'deny-and-continue',
  };

  it('is answerable in the run view itself, without a trip to another screen', async () => {
    stubFetch({ approvals: [permissionApproval], run: { ...runningRun, state: 'waiting_approval' } });
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await render(<InboxHarness Inbox={InboxView} />);
    const row = await waitForElement(container, '[data-testid="run-waiting_approval"]');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const banner = await waitForElement(container.querySelector('.report') as HTMLElement, '[data-testid="run-needs-you"]');
    expect(banner.textContent).toContain('NEEDS YOU');
    expect(banner.textContent, 'the card has to name what is being asked').toContain('Bash');
    // The decision itself, in the same pane as the output.
    const buttons = Array.from(banner.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Approve');
    expect(buttons).toContain('Deny');
    expect(container.querySelector('[data-testid="live-tail"]'), 'the run is still live, so the tail stays').not.toBeNull();
  });

  it('says nothing about approvals when none belong to this run', async () => {
    stubFetch({ approvals: [{ ...permissionApproval, run_id: 'some_other_run' }] });
    const container = await openRun();
    expect(container.querySelector('.report')!.querySelector('[data-testid="run-needs-you"]')).toBeNull();
  });
});
