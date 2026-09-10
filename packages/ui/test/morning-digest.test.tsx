/**
 * The morning-after digest (T4-9), counted against a real corpus.
 *
 * `packages/ui/test/helpers/overnight-corpus.ts` holds a week of runs produced
 * by the mock engine through the real daemon — see its header for what the
 * mock produced and what had to be shaped afterwards. Everything below counts
 * that week, so "the digest's numbers are right" means right about rows the
 * daemon actually wrote rather than right about rows a test author invented.
 *
 * Two kinds of assertion, the split `inbox-needsyou.test.tsx` uses:
 *   1. Pure — `digestOf` over the corpus, which is where the counting rules
 *      live and where an off-by-one is legible.
 *   2. Behaviour — a full `<InboxView>` render, which is the only thing that
 *      proves the digest is the landing view at all, and that it stays away
 *      when there is nothing unread.
 *
 * The in-flight run is the case with a documented posture to match, so it gets
 * its own block: `GET /analytics` counts an unfinished run and its spend, keeps
 * it out of `completed`/`failed`, and keeps it out of every rate's denominator
 * (api.ts:2637-2646). Each of those four is asserted separately, by removing
 * the one in-flight row from the corpus and diffing the digest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  digestOf,
  isUnread,
  nextCommandsFor,
  type DigestT,
} from '../src/components/InboxView';
import {
  EXPECTED_LAST_NIGHT,
  EXPECTED_LONG_WEEKEND,
  LAST_READ_LAST_NIGHT,
  LAST_READ_LONG_WEEKEND,
  NOW,
  OPEN_APPROVALS,
  WEEK_OF_RUNS,
} from './helpers/overnight-corpus';
import { renderComponent, waitForText, waitForTextGone, neverHappens } from './helpers/dom';

/** A line only the digest body draws — the heading is repeated by the back control. */
const DIGEST_BODY_LINE = 'Everything since you last read the inbox';

/** The run ids every test below names, so a corpus edit fails loudly here first. */
const IN_FLIGHT_RUN = 'r-018';
const NEEDS_YOU_RUN = 'r-019';

const needsYouIds = new Set(OPEN_APPROVALS.map((a) => String(a.run_id)));

function longWeekend(runs = WEEK_OF_RUNS): DigestT {
  return digestOf(runs, needsYouIds, LAST_READ_LONG_WEEKEND, NOW);
}

// ---------------------------------------------------------------------------
// The corpus is what it claims to be. A fixture that quietly loses its
// in-flight row would make every assertion below vacuous.
// ---------------------------------------------------------------------------
describe('the seeded corpus', () => {
  it('holds one run still in flight, with spend and no end time', () => {
    const r = WEEK_OF_RUNS.find((x) => x.id === IN_FLIGHT_RUN);
    expect(r, `${IN_FLIGHT_RUN} is gone from the corpus`).toBeDefined();
    expect(r!.state).toBe('running');
    expect(r!.ended_at).toBeNull();
    expect(r!.cost_usd).toBeGreaterThan(0);
  });

  it('holds a finalized run with an approval still open', () => {
    expect(needsYouIds.has(NEEDS_YOU_RUN)).toBe(true);
    expect(WEEK_OF_RUNS.find((x) => x.id === NEEDS_YOU_RUN)!.state).toBe('completed');
  });

  it('holds a budget bust, which analytics does not call a failure', () => {
    expect(WEEK_OF_RUNS.some((x) => x.state === 'budget_exceeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The counts.
// ---------------------------------------------------------------------------
describe('digestOf counts a five-day window', () => {
  it('agrees with GET /analytics on every number the two both compute', () => {
    const d = longWeekend();
    expect(d.runs).toBe(EXPECTED_LONG_WEEKEND.runs);
    expect(d.completed).toBe(EXPECTED_LONG_WEEKEND.completed);
    expect(d.failed).toBe(EXPECTED_LONG_WEEKEND.failed);
    expect(d.inFlight).toBe(EXPECTED_LONG_WEEKEND.inFlight);
    expect(d.costUsd).toBe(EXPECTED_LONG_WEEKEND.costUsd);
    expect(d.successRate).toBe(EXPECTED_LONG_WEEKEND.successRate);
    expect(d.finished).toBe(EXPECTED_LONG_WEEKEND.finished);
  });

  it('counts the four things analytics has no opinion about', () => {
    const d = longWeekend();
    expect(d.needsYou).toBe(EXPECTED_LONG_WEEKEND.needsYou);
    expect(d.costUnreported).toBe(EXPECTED_LONG_WEEKEND.costUnreported);
    expect(d.branchesWaiting).toBe(EXPECTED_LONG_WEEKEND.branchesWaiting);
    expect(d.exceptions).toHaveLength(EXPECTED_LONG_WEEKEND.exceptions);
  });

  it('answers the overnight case — three jobs ran while you slept', () => {
    const d = digestOf(WEEK_OF_RUNS, needsYouIds, LAST_READ_LAST_NIGHT, NOW);
    expect(d.runs).toBe(EXPECTED_LAST_NIGHT.runs);
    expect(d.completed).toBe(EXPECTED_LAST_NIGHT.completed);
    expect(d.inFlight).toBe(EXPECTED_LAST_NIGHT.inFlight);
    expect(d.needsYou).toBe(EXPECTED_LAST_NIGHT.needsYou);
    expect(d.costUsd).toBe(EXPECTED_LAST_NIGHT.costUsd);
    expect(d.branchesWaiting).toBe(EXPECTED_LAST_NIGHT.branchesWaiting);
    expect(d.successRate).toBe(EXPECTED_LAST_NIGHT.successRate);
    expect(d.exceptions).toHaveLength(EXPECTED_LAST_NIGHT.exceptions);
  });

  it('excludes a booking that has not happened yet', () => {
    // `GET /runs` returns future rows too. Analytics bounds its window at
    // `to`; so does the digest, and this is the row that proves it.
    const tomorrow = {
      ...WEEK_OF_RUNS.find((r) => r.id === IN_FLIGHT_RUN)!,
      id: 'r-future',
      state: 'scheduled',
      started_at: null,
      ended_at: null,
      scheduled_for: NOW + 18 * 3_600_000,
      cost_usd: 0,
    };
    expect(longWeekend([...WEEK_OF_RUNS, tomorrow]).runs).toBe(EXPECTED_LONG_WEEKEND.runs);
  });
});

// ---------------------------------------------------------------------------
// The in-flight run, one assertion per rule analytics states.
// ---------------------------------------------------------------------------
describe('an in-flight run is handled the way GET /analytics handles it', () => {
  const withIt = longWeekend();
  const withoutIt = longWeekend(WEEK_OF_RUNS.filter((r) => r.id !== IN_FLIGHT_RUN));
  const inFlightCost = WEEK_OF_RUNS.find((r) => r.id === IN_FLIGHT_RUN)!.cost_usd;

  it('is counted as a run, and reported separately as in-flight', () => {
    expect(withIt.runs - withoutIt.runs).toBe(1);
    expect(withIt.inFlight).toBe(1);
    expect(withoutIt.inFlight).toBe(0);
    expect(withIt.runs).toBe(withIt.finished + withIt.inFlight);
  });

  it('has its spend so far counted — that money is already gone', () => {
    expect(Math.round((withIt.costUsd - withoutIt.costUsd) * 10_000) / 10_000).toBe(inFlightCost);
    expect(inFlightCost).toBeGreaterThan(0);
  });

  it('is never counted as completed and never as failed', () => {
    expect(withIt.completed).toBe(withoutIt.completed);
    expect(withIt.failed).toBe(withoutIt.failed);
    expect(withIt.finished).toBe(withoutIt.finished);
  });

  it('is kept out of the rate denominator, so the success rate does not move', () => {
    expect(withIt.successRate).toBe(withoutIt.successRate);
  });

  it('is not an exception — a run that is merely still going is not bad news', () => {
    expect(withIt.exceptions.map((e) => e.runId)).not.toContain(IN_FLIGHT_RUN);
  });

  it('reports no success rate at all when nothing in the window has finished', () => {
    // Analytics answers 0 here, which reads as "0% completed" in a headline.
    const only = WEEK_OF_RUNS.filter((r) => r.id === IN_FLIGHT_RUN);
    const d = digestOf(only, needsYouIds, LAST_READ_LONG_WEEKEND, NOW);
    expect(d.runs).toBe(1);
    expect(d.successRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exceptions first.
// ---------------------------------------------------------------------------
describe('the exceptions list', () => {
  it('puts the run waiting on a human above every run that merely broke', () => {
    const d = longWeekend();
    expect(d.exceptions[0]!.kind).toBe('needs_you');
    expect(d.exceptions[0]!.runId).toBe(NEEDS_YOU_RUN);
    expect(d.exceptions.slice(1).every((e) => e.kind === 'went_wrong')).toBe(true);
  });

  it('orders what went wrong newest first', () => {
    const wrong = longWeekend().exceptions.filter((e) => e.kind === 'went_wrong');
    const times = wrong.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('includes the budget bust the analytics failure count leaves out', () => {
    const d = longWeekend();
    expect(d.exceptions.some((e) => e.state === 'budget_exceeded')).toBe(true);
    // …and the number still uses the narrower set, which is the whole point.
    expect(d.failed).toBe(EXPECTED_LONG_WEEKEND.failed);
    expect(d.exceptions.filter((e) => e.kind === 'went_wrong')).toHaveLength(
      EXPECTED_LONG_WEEKEND.failed + 1,
    );
  });

  it('carries the reason the daemon recorded, so a row explains itself', () => {
    const streak = longWeekend().exceptions.filter((e) => e.reason === 'max_turns');
    expect(streak.length).toBeGreaterThanOrEqual(3);
    expect(streak.every((e) => e.taskName === 'Flaky e2e triage')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUnread — the gate, kept in step with the row it came from.
// ---------------------------------------------------------------------------
describe('isUnread', () => {
  it('is false for every row once the inbox has been read to now', () => {
    expect(WEEK_OF_RUNS.some((r) => isUnread(r, NOW))).toBe(false);
  });

  it('is false for a live run — nothing has arrived from it yet', () => {
    const live = WEEK_OF_RUNS.find((r) => r.id === IN_FLIGHT_RUN)!;
    expect(isUnread(live, 0)).toBe(false);
  });

  it('is true for a run that finished after the last read', () => {
    const done = WEEK_OF_RUNS.find((r) => r.id === NEEDS_YOU_RUN)!;
    expect(isUnread(done, LAST_READ_LAST_NIGHT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behaviour: a full InboxView render.
// ---------------------------------------------------------------------------
const UNREAD_KEY = 'clockwork.inbox.lastRead';

function stubInbox(runs: unknown[], approvals: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.startsWith('/runs?')) return new Response(JSON.stringify(runs), { status: 200 });
      if (u === '/approvals') return new Response(JSON.stringify(approvals), { status: 200 });
      if (u.startsWith('/runs/')) {
        // A run selected out of the digest fetches its report; the digest
        // tests do not depend on its contents.
        return new Response(JSON.stringify({ run: runs[0], report: null }), { status: 200 });
      }
      if (u.startsWith('/workforce/')) return new Response('null', { status: 200 });
      throw new Error(`unexpected fetch in digest test: ${u}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the digest is the Inbox landing view when the night left something unread', () => {
  it('answers the morning question without opening a report', async () => {
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'While you were away');

    const digest = container.querySelector('[data-testid="inbox-digest"]');
    expect(digest, 'no digest rendered').not.toBeNull();
    const text = digest!.textContent ?? '';
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.runs} runs`);
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.completed} completed`);
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.inFlight} still running`);
    expect(text).toContain(`$${EXPECTED_LONG_WEEKEND.costUsd.toFixed(2)} spent`);
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.branchesWaiting} branches waiting for review`);
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.needsYou} waiting on you`);
    expect(text).toContain('did not finish cleanly');
    expect(text).toContain(`${EXPECTED_LONG_WEEKEND.successRate}% of finished runs completed`);
  });

  it('says a run reports no cost rather than folding a zero into the total', async () => {
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'reports no cost');
    expect(container.querySelector('[data-testid="digest-cost-unreported"]')!.textContent).toContain(
      `${EXPECTED_LONG_WEEKEND.costUnreported} run reports no cost`,
    );
  });

  it('lists the exceptions first, and each one opens its run', async () => {
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'While you were away');

    const rows = container.querySelectorAll('[data-testid^="digest-exception-"]');
    expect(rows).toHaveLength(EXPECTED_LONG_WEEKEND.exceptions);
    expect(rows[0]!.getAttribute('data-testid')).toBe('digest-exception-needs_you');

    // The digest's own sentence, not its heading: the back control repeats
    // the heading, so waiting on that would wait for something still on screen.
    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForTextGone(container, DIGEST_BODY_LINE);
    expect(container.querySelector('[data-testid="inbox-digest"]'), 'the digest should give way to the report').toBeNull();
    expect(container.querySelector('[data-testid="digest-back"]'), 'no way back to the digest').not.toBeNull();
  });

  it('comes back after a report is read, without re-reading the window it already showed', async () => {
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'While you were away');

    const before = container.querySelector('[data-testid="digest-totals"]')!.textContent;
    container
      .querySelector('[data-testid^="digest-exception-"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForTextGone(container, DIGEST_BODY_LINE);

    // Opening a run advances `lastRead`. If the digest read that, its window
    // would shrink under the reader's feet, one exception at a time.
    container.querySelector('[data-testid="digest-back"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForText(container, DIGEST_BODY_LINE);
    expect(container.querySelector('[data-testid="digest-totals"]')!.textContent).toBe(before);
  });
});

describe('the digest stays away when there is nothing unread', () => {
  it('is absent when every run has already been read', async () => {
    localStorage.setItem(UNREAD_KEY, String(NOW));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'Select a run to read its report.');
    await neverHappens(
      () => container.querySelector('[data-testid="inbox-digest"]') !== null,
      'a digest over an inbox with nothing unread',
      { describe: () => container.textContent ?? '' },
    );
  });

  it('is absent when the only thing in the window is a run still going', async () => {
    // A run in flight makes nothing unread: nothing has arrived from it yet.
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS.filter((r) => r.id === IN_FLIGHT_RUN), []);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'Select a run to read its report.');
    expect(container.querySelector('[data-testid="inbox-digest"]')).toBeNull();
  });

  it('is absent for an inbox with no runs at all', async () => {
    stubInbox([], []);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'No runs yet. Book one from the calendar.');
    expect(container.querySelector('[data-testid="inbox-digest"]')).toBeNull();
  });

  it('goes away when the night is marked read', async () => {
    localStorage.setItem(UNREAD_KEY, String(LAST_READ_LONG_WEEKEND));
    stubInbox(WEEK_OF_RUNS, OPEN_APPROVALS);
    const { default: InboxView } = await import('../src/components/InboxView');
    const container = await renderComponent(<InboxView version={0} />);
    await waitForText(container, 'While you were away');
    container.querySelector('[data-testid="digest-mark-read"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForTextGone(container, DIGEST_BODY_LINE);
    expect(container.querySelector('[data-testid="inbox-digest"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextCommandsFor — the branch gate, which the corpus is the evidence for.
// ---------------------------------------------------------------------------
describe('nextCommandsFor', () => {
  const spec = { repoPath: '/Users/dev/demo-app', baseBranch: 'main' };

  it('offers nothing for a run that committed nothing, however its branch column reads', () => {
    // r-019 in the corpus: a completed repo run with a non-null `branch` whose
    // report says it committed nothing — the daemon deleted that branch at
    // finalize. A checkout command here would not work.
    const uncommitted = WEEK_OF_RUNS.find((r) => r.id === NEEDS_YOU_RUN)!;
    const report = JSON.parse(uncommitted.report_json!) as { committedSomething: boolean };
    expect(uncommitted.branch, 'the corpus no longer demonstrates the case').not.toBeNull();
    expect(report.committedSomething).toBe(false);
    expect(nextCommandsFor(spec, uncommitted.branch, report.committedSomething)).toEqual([]);
  });

  it('offers checkout, diff and a PR for a run that did commit', () => {
    const cmds = nextCommandsFor(spec, 'clockwork/nightly-deps-sweep/5', true);
    expect(cmds.map((c) => c.id)).toEqual(['checkout', 'diff', 'pr']);
    expect(cmds[0]!.command).toBe('git -C /Users/dev/demo-app checkout clockwork/nightly-deps-sweep/5');
    expect(cmds[1]!.command).toBe('git -C /Users/dev/demo-app diff main...clockwork/nightly-deps-sweep/5');
  });

  it('says out loud that the PR command assumes a remote and an unpushed branch', () => {
    const pr = nextCommandsFor(spec, 'clockwork/x/1', true).find((c) => c.id === 'pr')!;
    expect(pr.command).toContain('git push -u origin');
    expect(pr.caveat, 'an unchecked assumption must be stated, not hidden').toBeTruthy();
    expect(pr.caveat!).toContain('origin');
  });

  it('withholds diff and PR when the jobspec has no base branch', () => {
    const cmds = nextCommandsFor({ repoPath: '/Users/dev/demo-app', baseBranch: null }, 'clockwork/x/1', true);
    expect(cmds.map((c) => c.id)).toEqual(['checkout']);
  });

  it('offers nothing for a run with no repository', () => {
    expect(nextCommandsFor({ repoPath: null, baseBranch: null }, null, false)).toEqual([]);
  });
});
