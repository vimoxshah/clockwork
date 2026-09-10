/**
 * T1-9 — the report says "this Mac slept for 42 minutes", in words.
 *
 * THE DEFECT THIS FILE PINS, in two halves.
 *
 *   1. `sleptThroughKeepAwake` was a boolean the daemon hardcoded to `false`
 *      on every single run, and no screen rendered it at all. A user whose
 *      Mac slept through an overnight job could not learn that from the
 *      report — the one failure the README warns about hardest was the one
 *      the inbox could not describe.
 *
 *   2. The fix must not re-tell the lie. Every report already in a user's
 *      database carries `"sleptThroughKeepAwake": false`, written by that
 *      hardcoded line, about a window nobody watched. A banner keyed off the
 *      boolean would render "did not sleep" over all of them with the same
 *      confidence as a measured one. `describeSleep` therefore reads
 *      `sleptDuringRunMs` and nothing else: it is absent on every legacy
 *      report, and absence makes no claim.
 *
 * The third state is the interesting one and it has its own tests below: off
 * macOS, or on a run the daemon never observed, the answer is UNKNOWN. It
 * renders as silence. That is not the same as rendering "false", and the
 * difference survives in the stored data (`0` vs the key being absent).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSleep } from '../src/components/InboxView';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const INBOX = readFileSync(resolve(SRC, 'components/InboxView.tsx'), 'utf8');

/** What the daemon actually writes for a 42-minute sleep: a floor, one sample low. */
const FORTY_TWO_MINUTES = 42 * 60_000 - 15_000;

// ---------------------------------------------------------------------------
// 1. The sentence (pure)
// ---------------------------------------------------------------------------

describe('describeSleep turns a measured window into a sentence', () => {
  it('names the machine, the duration and what it cost', () => {
    expect(describeSleep({ sleptDuringRunMs: FORTY_TWO_MINUTES })).toBe(
      '⏾ This Mac slept for about 42 minutes during this run. The agent was frozen for that time.',
    );
  });

  it('reads as prose, not as a field dump', () => {
    const s = describeSleep({ sleptDuringRunMs: FORTY_TWO_MINUTES })!;
    expect(s, 'the user is being shown an identifier instead of being told something').not.toMatch(
      /sleptThroughKeepAwake|sleptDuringRunMs|true|false/,
    );
    expect(s).toMatch(/^\S+ This Mac slept for/);
    expect(s.endsWith('.')).toBe(true);
  });

  it('picks the unit a person would use', () => {
    expect(describeSleep({ sleptDuringRunMs: 65_000 })).toContain('65 seconds');
    expect(describeSleep({ sleptDuringRunMs: 9 * 60_000 })).toContain('9 minutes');
    expect(describeSleep({ sleptDuringRunMs: 3 * 3_600_000 })).toContain('3 hours');
    expect(describeSleep({ sleptDuringRunMs: 3 * 3_600_000 + 25 * 60_000 })).toContain('3h 25m');
  });

  it('says nothing about a window that was watched and stayed awake', () => {
    // `0` is a real answer, and the honest way to deliver it is silence: a
    // line on every clean report saying the Mac did not sleep is noise the
    // user must read past to find the reports that matter.
    expect(describeSleep({ sleptDuringRunMs: 0 })).toBeNull();
  });

  it('says nothing when nobody checked — and NOT "it did not happen"', () => {
    // Off macOS, or a run recovered after a daemon restart. This is the
    // assertion the whole task turns on: absence is not a denial.
    expect(describeSleep({})).toBeNull();
    expect(describeSleep(null)).toBeNull();
    expect(describeSleep(undefined)).toBeNull();
  });

  it('ignores the hardcoded boolean every stored report already carries', () => {
    // A report written before T1-9, byte for byte the shape finalize() used
    // to produce. `false` here was never measured; reading it would make this
    // function repeat the lie in a nicer font.
    const legacy = { sleptThroughKeepAwake: false } as { sleptDuringRunMs?: number };
    expect(describeSleep(legacy)).toBeNull();

    // And the reverse: a legacy `true` with no measurement behind it is not
    // a licence to invent a duration.
    const legacyTrue = { sleptThroughKeepAwake: true } as { sleptDuringRunMs?: number };
    expect(describeSleep(legacyTrue)).toBeNull();
  });

  it('refuses a corrupt value rather than printing NaN at a person', () => {
    expect(describeSleep({ sleptDuringRunMs: Number.NaN })).toBeNull();
    expect(describeSleep({ sleptDuringRunMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(describeSleep({ sleptDuringRunMs: -1 })).toBeNull();
    expect(describeSleep({ sleptDuringRunMs: 'a while' as unknown as number })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. It is on the screen
// ---------------------------------------------------------------------------

const now = 1_700_000_000_000;

function completedRun(reportJson: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'run_slept',
    task_id: 'task_slept',
    state: 'completed',
    outcome_reason: null,
    cost_usd: 0.1,
    turns: 3,
    started_at: now - 3 * 3_600_000,
    ended_at: now,
    scheduled_for: now - 3 * 3_600_000,
    branch: null,
    worktree_path: null,
    report_json: JSON.stringify(reportJson),
    jobspec_json: JSON.stringify({ taskName: 'Overnight digest', engine: 'claude' }),
  };
}

/** Every endpoint the report detail touches for a finished run. */
function stubFetch(run: Record<string, unknown>, report: Record<string, unknown>): void {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.startsWith('/runs?')) return json([run]);
      if (u === '/approvals') return json([]);
      if (/^\/runs\/[^/]+\/report$/.test(u)) return json({ run, report });
      if (/^\/runs\/[^/]+\/transcript$/.test(u)) return json({ available: false, lines: [] });
      if (/^\/runs\/[^/]+\/events/.test(u)) return json({ runId: run.id, since: 0, from: 0, nextSince: 0, lines: [], skipped: 0, complete: true });
      if (/^\/workforce\/handoff\//.test(u)) return json({ memories: [] });
      if (/^\/workforce\/runs\/[^/]+\/proposed-events$/.test(u)) return json({ events: [] });
      throw new Error(`unexpected fetch in sleep-sentence test: ${u}`);
    }),
  );
}

function Harness({ Inbox }: { Inbox: (p: { version: number }) => JSX.Element }): JSX.Element {
  const [version] = useState(0);
  useEffect(() => {}, []);
  return <Inbox version={version} />;
}

/** Mount the inbox and open the one run in it. */
async function openReport(report: Record<string, unknown>): Promise<HTMLDivElement> {
  const run = completedRun(report);
  stubFetch(run, report);
  const { default: InboxView } = await import('../src/components/InboxView');
  const container = await renderComponent(<Harness Inbox={InboxView} />);
  const row = await waitForElement(container, '[data-testid="run-completed"]');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // The summary proves the report pane actually rendered, so an absence
  // assertion after this point is about the banner and not about timing.
  await waitForText(container, 'Digest written.');
  return container;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the inbox shows the sentence on the report', () => {
  it('tells the user their Mac slept, and for how long', async () => {
    const container = await openReport({
      summary: 'Digest written.',
      sleptDuringRunMs: FORTY_TWO_MINUTES,
      sleptThroughKeepAwake: true,
      ranLateMs: 0,
      diffStat: [],
      coveredOccurrences: [],
      deliveries: [],
    });
    const banner = await waitForElement(container, '[data-testid="run-slept"]');
    expect(banner.textContent).toContain('This Mac slept for about 42 minutes during this run');
    expect(banner.getAttribute('role'), 'a sleep is news, not a footnote').toBe('alert');
  });

  it('shows nothing on a run the daemon watched and found awake', async () => {
    const container = await openReport({
      summary: 'Digest written.',
      sleptDuringRunMs: 0,
      sleptThroughKeepAwake: false,
      ranLateMs: 0,
      diffStat: [],
      coveredOccurrences: [],
      deliveries: [],
    });
    expect(container.querySelector('[data-testid="run-slept"]')).toBeNull();
    expect(container.textContent).not.toMatch(/slept/i);
  });

  it('shows nothing — and denies nothing — on a report written before T1-9', async () => {
    // The exact shape finalize() produced until T1-9: the boolean present and
    // false, no measurement anywhere. It must render, and it must not turn
    // into "your Mac stayed awake".
    const container = await openReport({
      summary: 'Digest written.',
      sleptThroughKeepAwake: false,
      ranLateMs: 0,
      diffStat: [],
      coveredOccurrences: [],
      deliveries: [],
    });
    expect(container.querySelector('[data-testid="run-slept"]')).toBeNull();
    expect(container.textContent).not.toMatch(/slept|stayed awake|did not sleep/i);
  });

  it('still renders a report that has neither field at all', async () => {
    // Older still. The point is that nothing throws: a shipped report with
    // the old shape must not take the inbox down.
    const container = await openReport({ summary: 'Digest written.', ranLateMs: 0 });
    expect(container.textContent).toContain('Digest written.');
    expect(container.querySelector('[data-testid="run-slept"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The claim that was there before, with nothing behind it
// ---------------------------------------------------------------------------

describe('the inbox no longer blames sleep for a run that merely started late', () => {
  it('has dropped the "(machine slept)" parenthetical from the late-run hint', () => {
    // `ranLateMs` is the gap between the booked time and the start. A queued
    // run, a held repo mutex or a daemon restart all produce it, and none of
    // them is a sleep. That parenthetical was the same defect T1-9 fixes,
    // rendered — an unmeasured cause stated as fact.
    // The RENDERED line, not the file: the comment above it in InboxView.tsx
    // quotes the old wording to say why it went, and grepping the whole file
    // would read that explanation as the defect.
    const lateLine = INBOX.split('\n').find((l) => l.includes('report.ranLateMs / 60000'));
    expect(lateLine, 'the late-run hint moved; this tripwire no longer reads it').toBeTruthy();
    expect(lateLine!, 'the inbox is guessing a cause again').not.toContain('machine slept');
    expect(lateLine!).toMatch(/Ran \{Math\.round\(report\.ranLateMs \/ 60000\)\}m late\./);
  });

  it('mounts the sleep banner off the measurement, never off the boolean', () => {
    // A helper nothing renders reports nothing. And a banner keyed off
    // `sleptThroughKeepAwake` would fire on the hardcoded `false` of every
    // legacy report, which is why the mount must go through describeSleep.
    expect(INBOX).toContain('describeSleep(report)');
    expect(INBOX).toContain('data-testid="run-slept"');
    expect(INBOX, 'the banner reads the field that was never computed').not.toMatch(
      /report\??\.\s*sleptThroughKeepAwake/,
    );
  });
});
