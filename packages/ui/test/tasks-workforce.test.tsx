/**
 * Tasks: the plan-then-execute gate (F1), sentinels (F4) and repo-shipped
 * jobs (F5).
 *
 * THE BUG THESE TESTS EXIST FOR. The execute half of a plan-then-execute pair
 * is a task row like any other — paused, with Enable and Run now beside it —
 * and both of those buttons are refused by the daemon with a 409. `enable` is
 * refused at EVERY pair status, because turning the half on would let a later
 * plan run start it carrying a plan nobody read; `run-now` is refused until a
 * human has approved THAT plan (daemon api.ts:320-345, ADR-039). Every click
 * was a guaranteed failure, and the row said nothing about why.
 *
 * Two kinds of assertion, matching workforce-inbox.test.tsx:
 *   1. Source-level: TasksView imports and RENDERS each section. A section
 *      nobody mounts is a feature nobody can reach, and no isolated render
 *      test would notice.
 *   2. Behaviour-level (jsdom + createRoot, no new dependency): the rows and
 *      cards draw only the controls the daemon would accept.
 *
 * Radix `Select` is never opened here on purpose — it needs pointer-capture
 * APIs jsdom does not implement. The filtering rules behind those pickers are
 * exported as pure functions and asserted directly instead.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanExecutePairT, RepoJobOfferT, RunRowT, TaskViewT } from '../src/api';
import { renderComponent, waitFor, waitForElement, waitForText, waitForTextGone } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TASKS_VIEW = readFileSync(resolve(SRC, 'components/TasksView.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function task(over: Partial<TaskViewT> & { id: string; name: string }): TaskViewT {
  return {
    prompt: 'do the thing',
    profileId: null,
    repoPath: null,
    permissionMode: 'acceptEdits',
    budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    missedPolicy: 'run-late',
    overlapPolicy: 'skip',
    enabled: false,
    version: 1,
    nextFire: null,
    ...over,
  };
}

function pair(over: Partial<PlanExecutePairT> = {}): PlanExecutePairT {
  return {
    id: 'pair_1',
    planTaskId: 'task_plan',
    executeTaskId: 'task_exec',
    planRunId: null,
    approvalId: null,
    executeRunId: null,
    status: 'awaiting_plan',
    decidedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function offer(over: Partial<RepoJobOfferT> = {}): RepoJobOfferT {
  return {
    id: 'off_1',
    repoPath: '/Users/me/dev/widget',
    sourcePath: '/Users/me/dev/widget/.clockwork/jobs.json',
    jobKey: 'nightly-deps',
    name: 'Nightly dependency sweep',
    spec: {
      key: 'nightly-deps',
      name: 'Nightly dependency sweep',
      prompt: 'Update the lockfile and run the tests.',
      schedule: { kind: 'cron', cron: '0 3 * * *', tz: 'UTC' },
      description: 'Keeps dependencies current.',
    },
    digest: 'abcdef0123456789',
    preview: { flags: [{ level: 'info', text: 'Imported templates arrive DISABLED — review then enable.' }], arrivesDisabled: true },
    status: 'offered',
    taskId: null,
    discoveredAt: 1_700_000_000_000,
    decidedAt: null,
    ...over,
  };
}

/** A TERMINAL run by default — most fixtures here feed last-outcome/cost-trend, which only read terminal runs. */
function run(over: Partial<RunRowT> & { id: string; task_id: string }): RunRowT {
  return {
    state: 'completed',
    outcome_reason: null,
    cost_usd: 0,
    turns: 1,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_050_000,
    scheduled_for: 1_700_000_000_000,
    branch: null,
    worktree_path: null,
    report_json: null,
    jobspec_json: '{}',
    ...over,
  };
}

/** Route table → a fetch stub the frozen api client is happy with. */
function stubRoutes(routes: Record<string, () => unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url).split('?')[0]!;
      const handler = routes[path];
      if (!handler) return new Response(JSON.stringify({ error: `no stub for ${path}` }), { status: 404 });
      const body = handler();
      if (body instanceof Response) return body;
      if (body instanceof Promise) return body;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const render = renderComponent;

const textOf = (el: Element | null): string => el?.textContent ?? '';
const labels = (el: Element): string[] => [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

/**
 * React 18 delegates from the root container, which is in the document — a real
 * click reaches it. No wait here: a click is a discrete event, so React has
 * already flushed the state update by the time `click()` returns. Each caller
 * waits for its own ASYNC consequence (a fetch, a portal) instead.
 */
function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

/** React tracks the value node-side, so the native setter is the only way in. */
function type(el: Element | null | undefined, value: string): void {
  if (!el) throw new Error('nothing to type into');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el as HTMLInputElement, value);
  (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
}

const tabNamed = (root: Element, label: string): Element | undefined =>
  [...root.querySelectorAll('[role="tab"]')].find((b) => (b.textContent ?? '').trim().startsWith(label));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.location.hash = '';
});

// ---------------------------------------------------------------------------
// 1. the sections are actually mounted
// ---------------------------------------------------------------------------

describe('Tasks mounts the three workforce sections it owns (F1, F4, F5)', () => {
  it('imports each section', () => {
    expect(TASKS_VIEW).toContain("import PlanExecuteSection from './PlanExecuteSection'");
    expect(TASKS_VIEW).toContain("import SentinelsSection from './SentinelsSection'");
    expect(TASKS_VIEW).toContain("import RepoJobsSection from './RepoJobsSection'");
  });

  it('renders each one behind the section switch', () => {
    expect(TASKS_VIEW).toContain("{section === 'pairs' && (");
    expect(TASKS_VIEW).toContain("{section === 'sentinels' && <SentinelsSection");
    expect(TASKS_VIEW).toContain("{section === 'repo' && (");
  });

  it('fetches the pairs in the VIEW, so the task rows and the pair board agree', () => {
    // If the pairs list only lived inside PlanExecuteSection, the task rows
    // could not ask it whether Run now / Enable would be refused.
    expect(TASKS_VIEW).toContain('const pairs = useAsync(() => api.planExecuteList(), [version]);');
  });

  it('offers a switch for every section', async () => {
    stubRoutes({
      '/tasks': () => [],
      '/queue': () => [],
      '/workforce/plan-execute': () => ({ pairs: [] }),
    });
    const { default: TasksView } = await import('../src/components/TasksView');
    const c = await render(<TasksView version={1} />);
    await waitForElement(c, '[data-testid="section-tasks"]');
    for (const key of ['tasks', 'pairs', 'sentinels', 'repo']) {
      expect(c.querySelector(`[data-testid="section-${key}"]`), key).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. the bug: the execute half is not an ordinary paused task
// ---------------------------------------------------------------------------

const EXEC_TASK = task({ id: 'task_exec', name: 'Ship it — execute' });
const PLAIN_TASK = task({ id: 'task_plain', name: 'Weekly docs sweep' });

async function renderTasks(pairs: PlanExecutePairT[] | 'error' | 'pending'): Promise<HTMLDivElement> {
  stubRoutes({
    '/tasks': () => [EXEC_TASK, PLAIN_TASK],
    '/queue': () => [],
    '/workforce/plan-execute': () =>
      pairs === 'error'
        ? new Response(JSON.stringify({ error: 'database is locked' }), { status: 500 })
        : pairs === 'pending'
          ? new Promise(() => {}) // never settles: the load-time race
          : { pairs },
  });
  const { default: TasksView } = await import('../src/components/TasksView');
  const c = await render(<TasksView version={1} />);
  // The task-count chip sits OUTSIDE the rowsReady gate (TasksView.tsx:300-306)
  // and reads tasks.data, so "2 tasks" is proof that GET /tasks has landed —
  // independently of the pair lookup, which is what every case here turns on.
  await waitForText(c, '2 tasks');
  if (pairs === 'pending') {
    // Deliberate "nothing should happen": the pairs promise never settles, so
    // the assertions are absences. The wait above is what makes them mean
    // something — the tasks HAVE arrived and the rows are still withheld,
    // rather than the whole view simply not having rendered yet.
    await waitForText(c, 'Loading tasks…');
  } else {
    // rowsReady = !tasks.loading && !tasks.error && !pairs.loading
    // (TasksView.tsx:221), and the spinner is drawn on exactly that condition,
    // so its disappearance is the moment the rows are decided.
    await waitForTextGone(c, 'Loading tasks…');
  }
  return c;
}

describe('the execute half of a plan-then-execute pair (the 409 bug)', () => {
  it('offers neither Enable nor Run now while the plan is waiting for approval', async () => {
    const c = await renderTasks([pair({ status: 'awaiting_approval', planRunId: 'run_plan', approvalId: 'appr_1' })]);
    const row = c.querySelector('[data-testid="task-row-execute-half"]')!;
    expect(row, 'the execute half must be recognised').not.toBeNull();
    expect(labels(row)).not.toContain('Enable');
    expect(labels(row)).not.toContain('Run now');
    expect(labels(row)).toContain('Review the plan');
    expect(textOf(row)).toContain('waiting on your approval');
    expect(textOf(row.querySelector('[data-testid="execute-half-reason"]'))).toContain('approving it books this run');
  });

  it('the review link actually reaches the approval, rather than just reading like one', async () => {
    // "Review the plan" is the replacement for two buttons that 409'd. A link
    // that draws but goes nowhere would be the same bug one indirection later,
    // so this asserts the handoff the Inbox listens for AND the tab switch.
    const c = await renderTasks([pair({ status: 'awaiting_approval', planRunId: 'run_plan', approvalId: 'appr_1' })]);
    const seen: string[] = [];
    const onOpen = (e: Event): void => void seen.push((e as CustomEvent<string>).detail);
    window.addEventListener('clockwork:open-run', onOpen);
    const row = c.querySelector('[data-testid="task-row-execute-half"]')!;
    click(row.querySelector('[data-testid="execute-half-link"]'));
    await waitFor(() => seen.length === 1, 'the clockwork:open-run handoff the Inbox listens for', {
      describe: () => `events seen = ${JSON.stringify(seen)}, hash = ${window.location.hash}`,
    });
    window.removeEventListener('clockwork:open-run', onOpen);
    expect(seen, 'the Inbox is told which run holds the plan').toEqual(['run_plan']);
    expect(window.location.hash, 'App routes on the whole hash, so it must be #/inbox').toBe('#/inbox');
  });

  it('leaves an ordinary paused task exactly as it was', async () => {
    const c = await renderTasks([pair({ status: 'awaiting_approval', planRunId: 'run_plan' })]);
    const rows = [...c.querySelectorAll('[data-testid="task-row"]')];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // T4-5: Delete moved into the row's overflow menu — it is no longer one
    // of the row's own top-level buttons, Run now still is (updated from the
    // pre-T4-5 layout, which drew all four at equal weight).
    expect(labels(row)).toEqual(expect.arrayContaining(['Run now', 'Enable', 'Edit']));
    expect(labels(row), 'Delete must not be a top-level button').not.toContain('Delete');
    expect(textOf(row)).toContain('paused');

    // The confirm step must survive the move: the overflow still reaches a
    // real Delete control, and clicking it still opens the same
    // ConfirmDialog rather than deleting outright.
    click(row.querySelector('[aria-label="More actions for Weekly docs sweep"]'));
    const deleteItem = await waitForElement(c, '[aria-label="Delete Weekly docs sweep"]');
    click(deleteItem);
    await waitForElement(c, '[role="dialog"]');
    expect(textOf(c.querySelector('[role="dialog"]'))).toContain('Delete “Weekly docs sweep”?');
  });

  it('refuses Run now while the plan has not been written yet, and says why', async () => {
    const c = await renderTasks([pair({ status: 'awaiting_plan' })]);
    const row = c.querySelector('[data-testid="task-row-execute-half"]')!;
    expect(labels(row)).not.toContain('Run now');
    expect(labels(row)).not.toContain('Enable');
    // there is no approval to link to yet — the link goes to the pair instead
    expect(labels(row)).toContain('See the pair');
    expect(textOf(row)).toContain('has not produced a plan yet');
  });

  it('allows Run now once a human approved that plan — and still never Enable', async () => {
    for (const status of ['approved', 'executed'] as const) {
      const c = await renderTasks([pair({ status, planRunId: 'run_plan', approvalId: 'appr_1', executeRunId: 'run_exec' })]);
      const row = c.querySelector('[data-testid="task-row-execute-half"]')!;
      expect(labels(row), status).toContain('Run now');
      expect(labels(row), status).not.toContain('Enable');
      document.body.innerHTML = '';
    }
  });

  it('keeps Run now refused after a rejected plan', async () => {
    const c = await renderTasks([pair({ status: 'rejected', approvalId: 'appr_1', decidedAt: 1_700_000_100_000 })]);
    const row = c.querySelector('[data-testid="task-row-execute-half"]')!;
    expect(labels(row)).not.toContain('Run now');
    expect(labels(row)).not.toContain('Enable');
    expect(textOf(row)).toContain('You rejected the plan');
  });

  it('tells the truth about a plan run that never finished (rejected with no approval)', async () => {
    const c = await renderTasks([pair({ status: 'rejected', approvalId: null })]);
    expect(textOf(c.querySelector('[data-testid="execute-half-reason"]'))).toContain('never finished');
  });

  it('draws no task action at all until the pair lookup has answered', async () => {
    // The load-time race: with `pairs` still in flight the view cannot know
    // which rows are execute halves, so a row rendered now would show the two
    // buttons this fix removes.
    const c = await renderTasks('pending');
    expect(c.querySelector('[data-testid="task-row"]')).toBeNull();
    expect(c.querySelector('[data-testid="task-row-execute-half"]')).toBeNull();
    expect(c.textContent).toContain('Loading tasks…');
  });

  it('says what it could not check when the pair lookup fails, and still shows the tasks', async () => {
    const c = await renderTasks('error');
    const banner = c.querySelector('[data-testid="pairs-unknown"]');
    expect(banner).not.toBeNull();
    expect(textOf(banner)).toContain('may be refused');
    expect(c.querySelectorAll('[data-testid="task-row"]')).toHaveLength(2);
  });

  it('marks the plan half as what it is, without gating it', async () => {
    stubRoutes({
      '/tasks': () => [task({ id: 'task_plan', name: 'Ship it — plan' })],
      '/queue': () => [],
      '/workforce/plan-execute': () => ({ pairs: [pair({ status: 'awaiting_plan' })] }),
    });
    const { default: TasksView } = await import('../src/components/TasksView');
    const c = await render(<TasksView version={1} />);
    await waitForElement(c, '[data-testid="task-row"]');
    const row = c.querySelector('[data-testid="task-row"]')!;
    expect(textOf(row)).toContain('plan half');
    expect(labels(row)).toContain('Run now'); // the plan half is an ordinary task
  });
});

describe('executeHalfGate — the daemon rule, stated once', () => {
  it('permits a manual run only where the daemon does', async () => {
    const { executeHalfGate } = await import('../src/components/TasksView');
    const allowed: Record<string, boolean> = {
      awaiting_plan: false,
      awaiting_approval: false,
      approved: true,
      executed: true,
      rejected: false,
    };
    for (const [status, canRun] of Object.entries(allowed)) {
      expect(executeHalfGate(pair({ status: status as PlanExecutePairT['status'] })).canRunNow, status).toBe(canRun);
    }
  });
});

// ---------------------------------------------------------------------------
// T4-5 — "a tasks list that reads like a schedule": Recurring/One-off/
// Finished grouping, the scratch label, and Delete demoted into an overflow
// menu behind Run now.
// ---------------------------------------------------------------------------

describe('T4-5 pure helpers — humanNextFire, taskBucket, costTrendFor, repoBasename', () => {
  it('humanNextFire: today is a bare time, tomorrow says so, the next six days carry the weekday, further out carries a date', async () => {
    const { humanNextFire } = await import('../src/components/TasksView');
    const NOW = new Date(2026, 8, 6, 14, 7); // Sunday 6 Sep 2026, 14:07
    const clock = { hour: 'numeric', minute: '2-digit' } as const;

    const laterToday = new Date(2026, 8, 6, 21, 30);
    expect(humanNextFire(laterToday.getTime(), NOW)).toBe(`today ${laterToday.toLocaleTimeString(undefined, clock)}`);

    const tomorrow = new Date(2026, 8, 7, 9, 0);
    expect(humanNextFire(tomorrow.getTime(), NOW)).toBe(`tomorrow ${tomorrow.toLocaleTimeString(undefined, clock)}`);

    const laterThisWeek = new Date(2026, 8, 10, 9, 0); // Thursday, 4 days out
    expect(humanNextFire(laterThisWeek.getTime(), NOW)).toBe(
      `${laterThisWeek.toLocaleDateString(undefined, { weekday: 'long' })} ${laterThisWeek.toLocaleTimeString(undefined, clock)}`,
    );

    const nextMonth = new Date(2026, 9, 20, 9, 0);
    expect(humanNextFire(nextMonth.getTime(), NOW)).toBe(
      `${nextMonth.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${nextMonth.toLocaleTimeString(undefined, clock)}`,
    );

    const nextYear = new Date(2027, 0, 4, 9, 0);
    expect(humanNextFire(nextYear.getTime(), NOW)).toBe(
      `${nextYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${nextYear.toLocaleTimeString(undefined, clock)}`,
    );
  });

  it('taskBucket: no run is One-off, a run plus a future fire is Recurring, a run with none left is Finished', async () => {
    const { taskBucket } = await import('../src/components/TasksView');
    expect(taskBucket({ nextFire: null }, false)).toBe('oneOff');
    // never fired yet — indistinguishable from a fresh one-off until it runs once (documented, self-correcting)
    expect(taskBucket({ nextFire: 4_102_444_800_000 }, false)).toBe('oneOff');
    expect(taskBucket({ nextFire: 4_102_444_800_000 }, true)).toBe('recurring');
    expect(taskBucket({ nextFire: null }, true)).toBe('finished');
  });

  it('costTrendFor: needs two terminal runs; direction follows the newest against the one before it', async () => {
    const { costTrendFor } = await import('../src/components/TasksView');
    expect(costTrendFor([])).toBeNull();
    expect(costTrendFor([{ cost_usd: 2 }])).toBeNull();
    expect(costTrendFor([{ cost_usd: 2 }, { cost_usd: 1 }])).toEqual({ direction: 'up', deltaUsd: 1 });
    expect(costTrendFor([{ cost_usd: 1 }, { cost_usd: 2 }])).toEqual({ direction: 'down', deltaUsd: 1 });
    expect(costTrendFor([{ cost_usd: 1 }, { cost_usd: 1 }])).toEqual({ direction: 'flat', deltaUsd: 0 });
  });

  it('repoBasename: the last path segment, trailing slashes ignored', async () => {
    const { repoBasename } = await import('../src/components/TasksView');
    expect(repoBasename('/Users/vimoxshah/Desktop/Vimox/poc/clockwork')).toBe('clockwork');
    expect(repoBasename('/Users/me/dev/widget/')).toBe('widget');
    expect(repoBasename('solo')).toBe('solo');
  });
});

describe('T4-5: the tasks list reads like a schedule', () => {
  const RECURRING_TASK = task({
    id: 'task_recurring',
    name: 'Weekly dep triage',
    enabled: true,
    nextFire: 4_102_444_800_000, // far future; bucketing only cares that it is non-null
    repoPath: '/Users/vimoxshah/Desktop/Vimox/poc/clockwork',
  });
  const ONEOFF_TASK = task({
    id: 'task_oneoff',
    name: 'OpenCode UI verify',
    enabled: true,
    nextFire: 4_102_444_800_000,
    // no runs stubbed for this id below — that is what keeps it One-off
  });
  const FINISHED_TASK = task({
    id: 'task_finished',
    name: 'Hermes live E2E',
    enabled: false,
    nextFire: null,
  });
  // Newest-first per task, matching what GET /runs actually returns — the
  // component trusts this order rather than re-sorting.
  const RUNS: RunRowT[] = [
    run({ id: 'r_rec_2', task_id: 'task_recurring', state: 'completed', cost_usd: 1.5, scheduled_for: 900 }),
    run({ id: 'r_rec_1', task_id: 'task_recurring', state: 'failed', cost_usd: 1.0, scheduled_for: 100 }),
    run({ id: 'r_fin_1', task_id: 'task_finished', state: 'completed', cost_usd: 2.25, scheduled_for: 500 }),
  ];

  async function renderGrouped(): Promise<HTMLDivElement> {
    stubRoutes({
      '/tasks': () => [RECURRING_TASK, ONEOFF_TASK, FINISHED_TASK],
      '/queue': () => [],
      '/workforce/plan-execute': () => ({ pairs: [] }),
      '/runs': () => RUNS,
    });
    const { default: TasksView } = await import('../src/components/TasksView');
    const c = await render(<TasksView version={1} />);
    await waitForText(c, '3 tasks');
    // Grouping and the outcome chip both need the /runs batch too — wait for
    // evidence it landed (the recurring task's outcome chip) before reading
    // group membership, rather than assuming it beat GET /tasks.
    await waitForElement(c, '[data-testid="last-outcome"]');
    return c;
  }

  it('groups Recurring before One-off before a collapsed Finished', async () => {
    const c = await renderGrouped();
    const groupIds = [...c.querySelectorAll('[data-testid^="tasks-group-"]')].map((el) => el.getAttribute('data-testid'));
    expect(groupIds, 'group order in the DOM').toEqual(['tasks-group-recurring', 'tasks-group-oneoff', 'tasks-group-finished']);

    expect(textOf(c.querySelector('[data-testid="tasks-group-recurring"]'))).toContain('Weekly dep triage');
    expect(textOf(c.querySelector('[data-testid="tasks-group-oneoff"]'))).toContain('OpenCode UI verify');

    // Finished is collapsed by default: the heading and count show, the row does not.
    const finishedSection = c.querySelector('[data-testid="tasks-group-finished"]')!;
    expect(textOf(finishedSection)).toContain('Finished (1)');
    expect(textOf(finishedSection)).not.toContain('Hermes live E2E');
    click(c.querySelector('[data-testid="tasks-finished-toggle"]'));
    await waitForText(c, 'Hermes live E2E');
  });

  it('never renders the bare internal word "scratch"; a repo-less task reads "no repo — scratch task"', async () => {
    const c = await renderGrouped();
    // Expand Finished too, so its (also repo-less) row is covered by the
    // whole-container check below, not just the two always-visible groups.
    click(c.querySelector('[data-testid="tasks-finished-toggle"]'));
    await waitForText(c, 'Hermes live E2E');

    // The OLD bug (landing-page/screens/09-approvals-tasks.png): a repo-less
    // row ended its hint line in the bare token itself, "· scratch". The
    // fix's own replacement text legitimately contains the substring
    // "scratch" (inside "scratch task"), so the check targets the old exact
    // form specifically rather than the word in isolation.
    expect(c.textContent).not.toContain('· scratch');
    expect(c.textContent).toContain('no repo — scratch task');

    // The row that DOES have a repo shows a basename, not the raw absolute
    // path, and carries the full path on hover via `title`.
    const recurringSection = c.querySelector('[data-testid="tasks-group-recurring"]')!;
    expect(textOf(recurringSection)).toContain('clockwork');
    expect(textOf(recurringSection)).not.toContain('/Users/vimoxshah/Desktop/Vimox/poc/clockwork');
    const repoSpan = [...recurringSection.querySelectorAll('span')].find(
      (s) => s.getAttribute('title') === '/Users/vimoxshah/Desktop/Vimox/poc/clockwork',
    );
    expect(repoSpan, 'the full path lives in title, for hover').not.toBeUndefined();
    expect(repoSpan!.textContent).toBe('clockwork');
  });

  it('demotes Delete into an overflow menu — Run now stays the only top-level primary action', async () => {
    const c = await renderGrouped();
    const oneOffSection = c.querySelector('[data-testid="tasks-group-oneoff"]')!;
    const row = oneOffSection.querySelector('[data-testid="task-row"]')!;
    expect(labels(row), 'Run now is still a top-level button').toContain('Run now');
    expect(labels(row), 'Delete is not a top-level button').not.toContain('Delete');

    click(row.querySelector('[aria-label="More actions for OpenCode UI verify"]'));
    const deleteItem = await waitForElement(c, '[aria-label="Delete OpenCode UI verify"]');
    expect(deleteItem.closest('[role="menu"]'), 'Delete lives inside the overflow menu').not.toBeNull();
  });

  it('shows the last outcome as a chip and a cost trend once there is history, and neither when there is none', async () => {
    const c = await renderGrouped();
    const recurringSection = c.querySelector('[data-testid="tasks-group-recurring"]')!;
    expect(textOf(recurringSection.querySelector('[data-testid="last-outcome"]'))).toContain('Completed'); // the newest run (r_rec_2)
    expect(textOf(recurringSection.querySelector('[data-testid="cost-trend"]'))).toContain('↑'); // 1.5 vs 1.0 before it

    // The one-off task has no run history at all — omitted, not a fake chip.
    const oneOffSection = c.querySelector('[data-testid="tasks-group-oneoff"]')!;
    expect(oneOffSection.querySelector('[data-testid="last-outcome"]')).toBeNull();
    expect(oneOffSection.querySelector('[data-testid="cost-trend"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. F1 — the pair board
// ---------------------------------------------------------------------------

function asyncState<T>(data: T | null, over: { loading?: boolean; error?: string | null } = {}) {
  return { data, loading: false, error: null, reload: (): void => {}, ...over };
}

describe('PlanExecuteSection (F1)', () => {
  it('offers a verdict only on the pair that is waiting for one', async () => {
    const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
    const rows = [
      pair({ id: 'p1', status: 'awaiting_approval', planRunId: 'run_a', approvalId: 'a1' }),
      pair({ id: 'p2', status: 'awaiting_plan', planTaskId: 'tp2', executeTaskId: 'te2' }),
      pair({ id: 'p3', status: 'executed', planTaskId: 'tp3', executeTaskId: 'te3', executeRunId: 'run_x' }),
    ];
    const c = await render(
      <PlanExecuteSection
        pairs={asyncState({ pairs: rows })}
        tasks={[]}
        onChanged={() => {}}
        onFindInTasks={() => {}}
      />,
    );
    await waitForElement(c, '[data-testid="pair-awaiting_approval"]');
    // one approve/reject pair of buttons, on the awaiting_approval row only
    expect(c.querySelectorAll('[data-testid="pair-approve"]')).toHaveLength(1);
    expect(c.querySelectorAll('[data-testid="pair-reject"]')).toHaveLength(1);
    const waiting = c.querySelector('[data-testid="pair-awaiting_approval"]')!;
    expect(waiting.querySelector('[data-testid="pair-approve"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="pair-awaiting_plan"]')!.querySelector('[data-testid="pair-approve"]')).toBeNull();
    expect(c.querySelector('[data-testid="pair-executed"]')!.querySelector('[data-testid="pair-reject"]')).toBeNull();
  });

  it('links to the halves only while there are halves to find', async () => {
    const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
    const rows = [pair({ id: 'p1', planTaskId: 'task_plan', executeTaskId: 'task_exec' })];
    const known = await render(
      <PlanExecuteSection
        pairs={asyncState({ pairs: rows })}
        tasks={[task({ id: 'task_plan', name: 'Ship it — plan' })]}
        onChanged={() => {}}
        onFindInTasks={() => {}}
      />,
    );
    await waitForElement(known, '[data-testid="pair-awaiting_plan"]');
    expect(labels(known)).toContain('Show both halves');
    document.body.innerHTML = '';
    // both halves deleted: the search would find nothing, so no button is drawn
    const gone = await render(
      <PlanExecuteSection pairs={asyncState({ pairs: rows })} tasks={[]} onChanged={() => {}} onFindInTasks={() => {}} />,
    );
    // This half asserts only an absence, so it would also pass against a board
    // that had not rendered. Wait for the pair row before counting buttons.
    await waitForElement(gone, '[data-testid="pair-awaiting_plan"]');
    expect(labels(gone)).not.toContain('Show both halves');
  });

  it('does not call an approved pair with no run "booked"', async () => {
    const { explainPair } = await import('../src/components/PlanExecuteSection');
    expect(explainPair(pair({ status: 'approved', executeRunId: null }))).toContain('was refused');
    expect(explainPair(pair({ status: 'approved', executeRunId: 'run_x' }))).toContain('was booked');
  });

  it('explains the feature instead of saying "nothing here"', async () => {
    const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
    const c = await render(
      <PlanExecuteSection pairs={asyncState({ pairs: [] })} tasks={[]} onChanged={() => {}} onFindInTasks={() => {}} />,
    );
    await waitForElement(c, '[data-testid="pe-empty"]');
    const empty = c.querySelector('[data-testid="pe-empty"]')!;
    expect(textOf(empty)).toContain('read the agent’s plan before it touches anything');
    expect(c.querySelector('[data-testid="pe-new"]')).not.toBeNull();
  });

  it('surfaces a failed load with a retry rather than an empty board', async () => {
    const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
    const c = await render(
      <PlanExecuteSection
        pairs={asyncState<{ pairs: PlanExecutePairT[] }>(null, { error: 'daemon unreachable' })}
        tasks={[]}
        onChanged={() => {}}
        onFindInTasks={() => {}}
      />,
    );
    await waitForElement(c, '[role="alert"]');
    expect(textOf(c.querySelector('[role="alert"]'))).toContain('daemon unreachable');
    expect(c.querySelector('[data-testid="pe-empty"]')).toBeNull();
  });

  // Regression: the "New pair" dialog used to be a hand-rolled
  // `role="dialog" aria-modal="true"` div. Its source-task Select portals its
  // listbox to <body>, and a hand-rolled aria-modal has no way to know that a
  // later-opened, body-level sibling is actually part of the dialog — a
  // screen reader could reach the dialog but not the picker inside it. The
  // fix is the app's own Radix-based Dialog (./ui/dialog), the pattern every
  // other modal form already uses (e.g. ComposerView's clone-URL dialog).
  it('does not hand-roll the dialog wrapper — it uses the app\'s real (Radix) Dialog', () => {
    const PLAN_EXECUTE_SRC = readFileSync(resolve(SRC, 'components/PlanExecuteSection.tsx'), 'utf8');
    expect(PLAN_EXECUTE_SRC).toContain("import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog'");
    expect(PLAN_EXECUTE_SRC).not.toContain('role="dialog" aria-modal="true"');
    expect(PLAN_EXECUTE_SRC).not.toContain('className="dialog-backdrop"');
  });

  it('opens "New pair" as a real dialog with the source-task Select reachable inside it', async () => {
    const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
    const c = await render(
      <PlanExecuteSection
        pairs={asyncState({ pairs: [] })}
        tasks={[task({ id: 't1', name: 'Nightly lint sweep' })]}
        onChanged={() => {}}
        onFindInTasks={() => {}}
      />,
    );
    await waitForElement(c, '[data-testid="pe-new"]');
    click(c.querySelector('[data-testid="pe-new"]'));
    // Radix mounts its portal in an effect, so this waits for the portal rather
    // than for 20ms.
    await waitForElement(document.body, '[role="dialog"]');

    // Radix portals dialog content to <body>, as a sibling of the render container.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog, 'the dialog must actually open').not.toBeNull();
    expect(document.body.querySelector('.dialog-backdrop'), 'the old hand-rolled wrapper must be gone').toBeNull();

    // The source-task picker must live INSIDE that same dialog node — that is
    // what keeps it inside the subtree Radix's one-time aria-hidden pass exempts.
    const select = dialog!.querySelector('[data-testid="pe-task-select"]');
    expect(select, 'the source-task picker must live inside the real dialog').not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. F4 — sentinels
// ---------------------------------------------------------------------------

describe('SentinelsSection (F4)', () => {
  const sentinel = {
    id: 'sen_1',
    name: 'Build went red',
    sentinelTaskId: 'task_watch',
    triggerId: 'trg_1',
    tripExpr: 'build failed',
    cooldownSec: 3600,
    lastTrippedAt: null,
    enabled: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it('does not offer a form it knows cannot succeed when there is no trigger', async () => {
    stubRoutes({ '/workforce/sentinels': () => ({ sentinels: [] }), '/triggers': () => [] });
    const { default: SentinelsSection } = await import('../src/components/SentinelsSection');
    const c = await render(<SentinelsSection version={1} tasks={[PLAIN_TASK]} />);
    // Drawn only on `!triggers.loading && !triggers.error && trgs.length === 0`
    // (SentinelsSection.tsx:115), so it proves GET /triggers has answered.
    await waitForElement(c, '[data-testid="sentinel-no-triggers"]');
    expect(c.querySelector('[data-testid="sentinel-no-triggers"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="sentinel-create"]')).toBeNull();
    expect(textOf(c)).toContain('Settings → Event triggers');
  });

  it('shows the form once a trigger exists, and starts it disabled until it is filled in', async () => {
    stubRoutes({
      '/workforce/sentinels': () => ({ sentinels: [] }),
      '/triggers': () => [{ id: 'trg_1', name: 'CI hook', source: 'webhook', filter: null, hasSecret: false, taskId: 'task_worker', enabled: true }],
    });
    const { default: SentinelsSection } = await import('../src/components/SentinelsSection');
    const c = await render(<SentinelsSection version={1} tasks={[PLAIN_TASK]} />);
    // `sentinel-empty` needs `!sentinels.loading`, so it is the load anchor here.
    await waitForElement(c, '[data-testid="sentinel-empty"]');
    const create = c.querySelector('[data-testid="sentinel-create"]') as HTMLButtonElement;
    expect(create).not.toBeNull();
    expect(create.disabled, 'an empty form must not post a 422').toBe(true);
    expect(c.querySelector('[data-testid="sentinel-empty"]')).not.toBeNull();
  });

  it('lists a sentinel with what it watches and what it books', async () => {
    stubRoutes({
      '/workforce/sentinels': () => ({ sentinels: [sentinel] }),
      '/triggers': () => [{ id: 'trg_1', name: 'CI hook', source: 'webhook', filter: null, hasSecret: false, taskId: 'task_worker', enabled: false }],
    });
    const { default: SentinelsSection } = await import('../src/components/SentinelsSection');
    const c = await render(
      <SentinelsSection version={1} tasks={[task({ id: 'task_watch', name: 'Cheap CI peek' }), task({ id: 'task_worker', name: 'Full investigation' })]} />,
    );
    await waitForElement(c, '[data-testid="sentinel-row"]');
    // The "trigger is off" chip needs GET /triggers as well as the sentinel
    // list, so it is the last of the two fetches to show up.
    await waitForElement(c, '[data-testid="sentinel-trigger-off"]');
    const row = c.querySelector('[data-testid="sentinel-row"]')!;
    expect(textOf(row)).toContain('Cheap CI peek');
    expect(textOf(row)).toContain('Full investigation');
    expect(textOf(row)).toContain('build failed');
    // a disabled trigger books nothing, and the row says so rather than implying it works
    expect(c.querySelector('[data-testid="sentinel-trigger-off"]')).not.toBeNull();
    // no edit control is drawn, because no route exists for one
    expect(labels(row)).not.toContain('Edit');
    expect(textOf(c)).toContain('cannot be edited');
  });

  it('never offers a trigger that would make the sentinel book its own run', async () => {
    const { usableTriggersFor } = await import('../src/components/SentinelsSection');
    const trgs = [
      { id: 'a', taskId: 'task_watch' },
      { id: 'b', taskId: 'task_worker' },
    ];
    expect(usableTriggersFor(trgs, 'task_watch').map((t) => t.id)).toEqual(['b']);
    expect(usableTriggersFor(trgs, 'task_other').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('translates every reason the daemon records for a check that booked nothing', async () => {
    const { explainTrip } = await import('../src/components/SentinelsSection');
    expect(explainTrip(null, true)).toContain('booked');
    expect(explainTrip('no_match', false)).toContain('did not contain the trip text');
    expect(explainTrip('cooldown', false)).toContain('cooldown');
    expect(explainTrip('trigger_disabled', false)).toContain('trigger is switched off');
    expect(explainTrip('policy_violation', false)).toContain('policy rule');
    // an unknown reason is shown, not swallowed
    expect(explainTrip('brand_new_reason', false)).toContain('brand_new_reason');
  });
});

// ---------------------------------------------------------------------------
// 5. F5 — repo-shipped jobs (the security surface)
// ---------------------------------------------------------------------------

describe('RepoJobsSection (F5) — import is a decision, not a click', () => {
  async function renderOffers(offers: RepoJobOfferT[]): Promise<HTMLDivElement> {
    stubRoutes({ '/workforce/repo-jobs': () => ({ offers }) });
    const { default: RepoJobsSection } = await import('../src/components/RepoJobsSection');
    return render(<RepoJobsSection version={1} onFindInTasks={() => {}} onTasksChanged={() => {}} />);
  }

  it('shows the prompt, the flags and the terms before it shows the button', async () => {
    const c = await renderOffers([offer()]);
    await waitForElement(c, '[data-testid="offer-prompt"]');
    expect(textOf(c.querySelector('[data-testid="offer-prompt"]'))).toContain('Update the lockfile');
    const terms = c.querySelector('[data-testid="offer-import-terms"]')!;
    expect(textOf(terms)).toContain('switched off');
    expect(textOf(terms)).toContain('acceptEdits');
    expect(textOf(terms)).toContain('$2 · 50 turns · 3600s');
    expect(textOf(terms)).toContain('cannot ask for a permission mode');
    expect(textOf(c)).toContain('Imported templates arrive DISABLED');
  });

  it('says the repo’s own schedule is not applied', async () => {
    const c = await renderOffers([offer()]);
    await waitForText(c, '0 3 * * *');
    expect(textOf(c)).toContain('0 3 * * *');
    expect(textOf(c)).toContain('not applied');
  });

  it('disables import when the security preview raises a red flag, with the reason', async () => {
    const c = await renderOffers([
      offer({ id: 'off_red', preview: { flags: [{ level: 'red', text: 'bypassPermissions is banned in H1 — import will be rejected.' }], arrivesDisabled: true } }),
    ]);
    await waitForElement(c, '[data-testid="offer-import"]');
    const btn = c.querySelector('[data-testid="offer-import"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(textOf(c.querySelector('[data-testid="offer-blocked"]'))).toContain('the button would only fail');
  });

  it('leaves import enabled for an ordinary offer', async () => {
    const c = await renderOffers([offer()]);
    await waitForElement(c, '[data-testid="offer-import"]');
    expect((c.querySelector('[data-testid="offer-import"]') as HTMLButtonElement).disabled).toBe(false);
    expect(c.querySelector('[data-testid="offer-dismiss"]')).not.toBeNull();
  });

  it('draws neither import nor dismiss on an offer that was already decided', async () => {
    const c = await renderOffers([
      offer({ id: 'off_done', status: 'imported', taskId: 'task_new', decidedAt: 1_700_000_100_000 }),
      offer({ id: 'off_gone', status: 'dismissed', decidedAt: 1_700_000_100_000 }),
    ]);
    // the board opens on the offers that still need a decision; these do not
    await waitForText(c, 'Nothing is waiting on your decision.');
    click(tabNamed(c, 'all'));
    await waitFor(
      () => c.querySelectorAll('[data-testid^="offer-"]').length > 0,
      'the decided offers to appear under the "all" filter',
      { describe: () => `offer nodes = ${c.querySelectorAll('[data-testid^="offer-"]').length}` },
    );
    expect(c.querySelectorAll('[data-testid^="offer-"]').length).toBeGreaterThan(0);
    // both routes CAS on status='offered' and 422 otherwise
    expect(c.querySelector('[data-testid="offer-import"]')).toBeNull();
    expect(c.querySelector('[data-testid="offer-dismiss"]')).toBeNull();
    expect(c.querySelector('[data-testid="offer-find"]')).not.toBeNull();
    expect(textOf(c.querySelector('[data-testid="offer-imported"]'))).toContain('paused task');
  });

  it('admits when an offer carries no security preview instead of implying it is clean', async () => {
    const c = await renderOffers([offer({ id: 'off_raw', preview: null })]);
    await waitForElement(c, '[data-testid="offer-no-preview"]');
    expect(textOf(c.querySelector('[data-testid="offer-no-preview"]'))).toContain('Read the prompt above yourself');
  });

  it('explains what the feature is when no repo has been read yet', async () => {
    const c = await renderOffers([]);
    await waitForElement(c, '[data-testid="rj-empty"]');
    expect(textOf(c.querySelector('[data-testid="rj-empty"]'))).toContain('.clockwork/jobs.json');
    expect((c.querySelector('[data-testid="rj-scan"]') as HTMLButtonElement).disabled, 'no path, no scan').toBe(true);
  });

  it('surfaces a failed listing rather than showing an empty, reassuring page', async () => {
    stubRoutes({ '/workforce/repo-jobs': () => new Response(JSON.stringify({ error: 'no such table' }), { status: 500 }) });
    const { default: RepoJobsSection } = await import('../src/components/RepoJobsSection');
    const c = await render(<RepoJobsSection version={1} onFindInTasks={() => {}} onTasksChanged={() => {}} />);
    await waitForElement(c, '[role="alert"]');
    expect(textOf(c.querySelector('[role="alert"]'))).toContain('no such table');
    expect(c.querySelector('[data-testid="rj-empty"]')).toBeNull();
  });

  it('the scan banner never claims "Nothing was imported" — that goes stale the moment you import one', async () => {
    stubRoutes({
      '/workforce/repo-jobs': () => ({ offers: [] }),
      '/workforce/repo-jobs/discover': () => ({ offers: [offer(), offer({ id: 'off_2', jobKey: 'ci-check', name: 'CI investigator' })] }),
    });
    const { default: RepoJobsSection } = await import('../src/components/RepoJobsSection');
    const c = await render(<RepoJobsSection version={1} onFindInTasks={() => {}} onTasksChanged={() => {}} />);
    await waitForElement(c, '[data-testid="rj-scan"]');
    type(c.querySelector('#rj-path'), '/Users/me/dev/widget');
    click(c.querySelector('[data-testid="rj-scan"]'));
    // The scan is a POST; the banner is what it produces.
    await waitForElement(c, '[data-testid="rj-scan-result"]');
    const banner = c.querySelector('[data-testid="rj-scan-result"]');
    expect(textOf(banner)).toContain('recommends 2 jobs');
    expect(textOf(banner)).not.toContain('Nothing was imported');
  });

  it('does not stutter the empty state ("No offered offers.") when a filter has zero rows', async () => {
    const c = await renderOffers([offer({ status: 'imported', taskId: 'task_new', decidedAt: 1_700_000_100_000 })]);
    // default filter is 'offered'; the only offer is already imported, so the offered view is empty
    await waitForText(c, 'Nothing is waiting on your decision.');
    expect(textOf(c)).not.toContain('No offered offers.');
    expect(textOf(c)).toContain('Nothing is waiting on your decision.');
  });
});
