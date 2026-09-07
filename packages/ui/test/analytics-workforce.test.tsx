/**
 * F10 (timesheets) and F11 (performance reviews) shipped with working daemon
 * routes and no way to reach them from the app. AnalyticsView is the only tab
 * that already mounts on screen, and App.tsx's routing is frozen, so the two
 * features are wired in as sub-tabs of Analytics rather than a new nav entry.
 *
 * Same two kinds of assertion as workforce-inbox.test.tsx:
 *   1. Source-level: AnalyticsView imports and RENDERS both new panels — an
 *      unmounted component is a feature the user cannot reach.
 *   2. Behavioural: each panel renders what it claims (including the honest
 *      hours-worked caveat and the "no profile to review" guard) and posts
 *      what a control claims to post.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimesheetT, RunRowT } from '../src/api';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ANALYTICS = readFileSync(resolve(SRC, 'components/AnalyticsView.tsx'), 'utf8');

describe('AnalyticsView mounts F10/F11 (the only reachable path, App.tsx is frozen)', () => {
  it('imports both panels', () => {
    expect(ANALYTICS).toContain("import TimesheetsPanel from './TimesheetsPanel'");
    expect(ANALYTICS).toContain("import PerformanceReviewsPanel from './PerformanceReviewsPanel'");
  });

  it('renders both panels behind the sub-tab switcher, sharing the existing days selector', () => {
    expect(ANALYTICS).toContain("{view === 'timesheets' && <TimesheetsPanel version={version} days={days} />}");
    expect(ANALYTICS).toContain("{view === 'performance' && <PerformanceReviewsPanel version={version} days={days} />}");
  });
});

const render = renderComponent;

/**
 * TimesheetsPanel awaits `Promise.allSettled([timesheet, runs])` and then sets
 * BOTH pieces of state in one continuation (TimesheetsPanel.tsx:105-133), so a
 * rendered timesheet row is proof the orphan cross-reference has also been
 * applied — or has failed and been given up on. That makes the row the correct
 * anchor for the orphan-chip cases too, including the one that asserts the
 * chip is absent.
 */
async function renderTimesheets(node: JSX.Element): Promise<HTMLDivElement> {
  const container = await renderComponent(node);
  await waitForText(container, 'Code Reviewer');
  return container;
}

/** React's controlled-input tracking bypasses a plain `el.value = x` — this
 * replicates the native setter dance so the framework's onChange actually fires. */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// TimesheetsPanel (F10)
// ---------------------------------------------------------------------------

const TIMESHEET_MOCK: TimesheetT = {
  fromMs: 1,
  toMs: 2,
  humanHourlyRateUsd: null,
  rows: [
    {
      profileId: 'prof_1',
      profileSlug: 'code-reviewer',
      profileName: 'Code Reviewer',
      runs: 3,
      hoursWorked: 12.5,
      dollarsSpent: 4.2,
      outcomesAccepted: 2,
      outcomesRejected: 0,
      effectiveHourlyRateUsd: 0.336,
    },
  ],
};

function orphanedRun(profileId: string): RunRowT {
  return {
    id: 'run_orphan',
    task_id: 'task_1',
    state: 'failed',
    outcome_reason: 'orphaned',
    cost_usd: 1.1,
    turns: 2,
    started_at: Date.now() - 5_000,
    ended_at: Date.now() - 1_000,
    scheduled_for: null,
    branch: null,
    worktree_path: null,
    report_json: null,
    jobspec_json: JSON.stringify({ profile: { id: profileId, name: 'Code Reviewer' } }),
  };
}

function stubTimesheetFetch(opts: { runsStatus?: number; runs?: RunRowT[] } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (/^\/workforce\/timesheets\?/.test(u)) {
      return new Response(JSON.stringify(TIMESHEET_MOCK), { status: 200 });
    }
    if (/^\/runs\?/.test(u)) {
      if (opts.runsStatus && opts.runsStatus >= 400) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: opts.runsStatus });
      }
      return new Response(JSON.stringify(opts.runs ?? []), { status: 200 });
    }
    if (/^\/workforce\/prefs\/hourly-rate$/.test(u)) {
      return new Response(JSON.stringify({ humanHourlyRateUsd: 85 }), { status: 200 });
    }
    throw new Error(`unexpected request: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('TimesheetsPanel (F10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the hours-worked caveat unconditionally, even when the orphan cross-reference fails', async () => {
    stubTimesheetFetch({ runsStatus: 500 });
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={1} days={30} />);
    const caveat = container.querySelector('[data-testid="hours-caveat"]');
    expect(caveat, 'the caveat must not depend on the runs cross-reference succeeding').not.toBeNull();
    expect(caveat!.textContent).toContain('daemon restart');
    // the underlying timesheet numbers must still render
    expect(container.textContent).toContain('Code Reviewer');
  });

  it('flags a row with a run interrupted by a daemon restart in this window', async () => {
    stubTimesheetFetch({ runs: [orphanedRun('prof_1')] });
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={2} days={30} />);
    const chip = container.querySelector('[data-testid="orphaned-chip"]');
    expect(chip, 'a run with outcome_reason=orphaned in-window must be flagged').not.toBeNull();
    expect(chip!.textContent).toContain('1 interrupted');
  });

  // The only assertion is an absence, so it used to pass against a panel that
  // had not rendered yet. `renderTimesheets` waits for the row first.
  it('does not flag a row when the interrupted run belongs to a different profile', async () => {
    stubTimesheetFetch({ runs: [orphanedRun('prof_other')] });
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={3} days={30} />);
    expect(container.querySelector('[data-testid="orphaned-chip"]')).toBeNull();
  });

  it('nudges the user to set their own rate when none is on record, instead of hiding the comparison silently', async () => {
    stubTimesheetFetch();
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={4} days={30} />);
    expect(container.textContent).toContain('Set your rate to see whether each agent is actually cheaper');
    // the effective rate itself must still be shown even with no human rate to compare against
    expect(container.textContent).toContain('$0.34/hr');
  });

  it('disables Save on an empty or negative rate — a control guaranteed to 422 must not be offered', async () => {
    stubTimesheetFetch();
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={5} days={30} />);
    const input = container.querySelector('[data-testid="human-rate-input"]') as HTMLInputElement;
    const save = container.querySelector('[data-testid="human-rate-save"]') as HTMLButtonElement;

    // React 18 flushes a discrete `input` event's update before dispatchEvent
    // returns, so these wait on the button state itself rather than on a clock.
    typeInto(input, '-1');
    await waitFor(() => save.disabled === true, 'Save to be disabled for a negative rate', {
      describe: () => `input.value = ${JSON.stringify(input.value)}, save.disabled = ${save.disabled}`,
    });
    expect(save.disabled, 'a negative rate must not be saveable').toBe(true);

    typeInto(input, '');
    await waitFor(() => save.disabled === true, 'Save to be disabled for a blank rate', {
      describe: () => `input.value = ${JSON.stringify(input.value)}, save.disabled = ${save.disabled}`,
    });
    expect(save.disabled, 'a blank rate must not be saveable').toBe(true);

    typeInto(input, '75');
    await waitFor(() => save.disabled === false, 'Save to be enabled for a valid rate', {
      describe: () => `input.value = ${JSON.stringify(input.value)}, save.disabled = ${save.disabled}`,
    });
    expect(save.disabled, 'a valid non-negative rate must be saveable').toBe(false);
  });

  it('Save posts the human hourly rate the user typed, as the numbers the effective rate is judged against', async () => {
    const fetchMock = stubTimesheetFetch();
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={6} days={30} />);
    const input = container.querySelector('[data-testid="human-rate-input"]') as HTMLInputElement;
    const save = container.querySelector('[data-testid="human-rate-save"]') as HTMLButtonElement;

    typeInto(input, '85');
    await waitFor(() => save.disabled === false, 'Save to be enabled for the typed rate', {
      describe: () => `input.value = ${JSON.stringify(input.value)}, save.disabled = ${save.disabled}`,
    });
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(
      () => fetchMock.mock.calls.some((c) => String(c[0]) === '/workforce/prefs/hourly-rate'),
      'the PUT to /workforce/prefs/hourly-rate',
      { describe: () => `fetch calls = ${JSON.stringify(fetchMock.mock.calls.map((c) => String(c[0])))}` },
    );

    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/workforce/prefs/hourly-rate');
    expect(call, 'Save must PUT /workforce/prefs/hourly-rate').toBeDefined();
    expect((call![1] as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ humanHourlyRateUsd: 85 });
  });

  it('surfaces a daemon error rather than swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'daemon exploded' }), { status: 500 })),
    );
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await render(<TimesheetsPanel version={7} days={30} />);
    await waitForElement(container, '[role="alert"]');
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('daemon exploded');
  });

  it('does not double-encode the sign in the vs-you comparison ("−$118.97/hr cheaper than you")', async () => {
    // effectiveHourlyRateUsd 0.336 vs a human rate of 120 — the agent is
    // cheaper, so the old copy prefixed a MINUS sign in front of "cheaper",
    // saying the same thing twice and inviting the opposite reading.
    const fn = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (/^\/workforce\/timesheets\?/.test(u)) {
        return new Response(JSON.stringify({ ...TIMESHEET_MOCK, humanHourlyRateUsd: 120 }), { status: 200 });
      }
      if (/^\/runs\?/.test(u)) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected request: ${u}`);
    });
    vi.stubGlobal('fetch', fn);
    const { default: TimesheetsPanel } = await import('../src/components/TimesheetsPanel');
    const container = await renderTimesheets(<TimesheetsPanel version={8} days={30} />);
    expect(container.textContent).toContain('cheaper than you');
    // neither ASCII hyphen-minus nor U+2212 MINUS SIGN in front of the dollar amount
    expect(container.textContent).not.toMatch(/[-−]\$\d/);
  });
});

// ---------------------------------------------------------------------------
// PerformanceReviewsPanel (F11)
// ---------------------------------------------------------------------------

const CARDS_MOCK = {
  cards: [
    {
      profileId: 'prof_1',
      profileSlug: 'code-reviewer',
      profileName: 'Code Reviewer',
      fromMs: 1,
      toMs: 2,
      runs: 4,
      acceptanceRate: null,
      failureRate: 0,
      costUsd: 3.5,
      costTrendUsd: null,
      decided: 0,
    },
    {
      profileId: null,
      profileSlug: null,
      profileName: 'Unassigned',
      fromMs: 1,
      toMs: 2,
      runs: 2,
      acceptanceRate: 1,
      failureRate: 0,
      costUsd: 0.5,
      costTrendUsd: 0.01,
      decided: 2,
    },
  ],
};

function stubPerformanceFetch(opts: { promptStatus?: number; promptText?: string } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (/^\/workforce\/performance\?/.test(u)) {
      return new Response(JSON.stringify(CARDS_MOCK), { status: 200 });
    }
    if (/^\/workforce\/performance\/prof_1\/review-prompt\?/.test(u)) {
      if (opts.promptStatus && opts.promptStatus >= 400) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: opts.promptStatus });
      }
      return new Response(JSON.stringify({ prompt: opts.promptText ?? 'Write a review for Code Reviewer.' }), { status: 200 });
    }
    throw new Error(`unexpected request: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('PerformanceReviewsPanel (F11)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says "not yet reviewed" rather than a false 0% when nothing has been decided', async () => {
    stubPerformanceFetch();
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={1} days={30} />);
    await waitForText(container, 'not yet reviewed (0 decided)');
    expect(container.textContent).toContain('not yet reviewed (0 decided)');
  });

  it('hides the review-prompt button for the Unassigned bucket — the route has no id to address', async () => {
    stubPerformanceFetch();
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={2} days={30} />);
    await waitForElement(container, '[data-testid="scorecard-__unassigned__"]');
    const unassignedCard = container.querySelector('[data-testid="scorecard-__unassigned__"]');
    expect(unassignedCard).not.toBeNull();
    expect(unassignedCard!.querySelector('[data-testid^="review-prompt-toggle-"]'), 'no profile id to call the route with').toBeNull();
    expect(unassignedCard!.textContent).toContain('no profile to review');
  });

  it('clicking "Get review prompt" fetches the prompt and shows it in full, with the booking instructions', async () => {
    stubPerformanceFetch({ promptText: 'Runs in period: 4\nWrite the verdict.' });
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={3} days={30} />);
    await waitForElement(container, '[data-testid="review-prompt-toggle-prof_1"]');
    const button = container.querySelector('[data-testid="review-prompt-toggle-prof_1"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForElement(container, '[data-testid="review-prompt-text-prof_1"]');

    const textarea = container.querySelector('[data-testid="review-prompt-text-prof_1"]') as HTMLTextAreaElement;
    expect(textarea, 'the prompt must actually render, not just fetch').not.toBeNull();
    expect(textarea.value).toContain('Write the verdict.');
    expect(container.textContent, 'the obvious next action must be spelled out').toContain('reviewer profile');
  });

  it('surfaces a daemon error on the prompt fetch instead of a blank panel', async () => {
    stubPerformanceFetch({ promptStatus: 404 });
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={4} days={30} />);
    await waitForElement(container, '[data-testid="review-prompt-toggle-prof_1"]');
    const button = container.querySelector('[data-testid="review-prompt-toggle-prof_1"]') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForElement(container, '[role="alert"]');

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('not_found');
  });

  it('pluralizes the run count — a scorecard with exactly one run must read "1 run", not "1 runs"', async () => {
    const fn = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (/^\/workforce\/performance\?/.test(u)) {
        return new Response(JSON.stringify({ cards: [{ ...CARDS_MOCK.cards[0], runs: 1 }] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${u}`);
    });
    vi.stubGlobal('fetch', fn);
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={5} days={30} />);
    await waitForText(container, '1 run');
    expect(container.textContent).toContain('1 run');
    expect(container.textContent).not.toContain('1 runs');
  });

  it('keeps the plural for a scorecard with more than one run', async () => {
    stubPerformanceFetch(); // CARDS_MOCK.cards[0].runs === 4
    const { default: PerformanceReviewsPanel } = await import('../src/components/PerformanceReviewsPanel');
    const container = await render(<PerformanceReviewsPanel version={6} days={30} />);
    await waitForText(container, '4 runs');
    expect(container.textContent).toContain('4 runs');
  });
});
