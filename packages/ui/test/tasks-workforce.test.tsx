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
import type { PlanExecutePairT, RepoJobOfferT, TaskViewT } from '../src/api';

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

async function render(node: JSX.Element): Promise<HTMLDivElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(node);
  await new Promise((r) => setTimeout(r, 40));
  return container;
}

const textOf = (el: Element | null): string => el?.textContent ?? '';
const labels = (el: Element): string[] => [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

/** React 18 delegates from the root container, which is in the document — a real click reaches it. */
async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 20));
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
  return render(<TasksView version={1} />);
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
    await click(row.querySelector('[data-testid="execute-half-link"]'));
    window.removeEventListener('clockwork:open-run', onOpen);
    expect(seen, 'the Inbox is told which run holds the plan').toEqual(['run_plan']);
    expect(window.location.hash, 'App routes on the whole hash, so it must be #/inbox').toBe('#/inbox');
  });

  it('leaves an ordinary paused task exactly as it was', async () => {
    const c = await renderTasks([pair({ status: 'awaiting_approval', planRunId: 'run_plan' })]);
    const rows = [...c.querySelectorAll('[data-testid="task-row"]')];
    expect(rows).toHaveLength(1);
    expect(labels(rows[0]!)).toEqual(expect.arrayContaining(['Run now', 'Enable', 'Edit', 'Delete']));
    expect(textOf(rows[0]!)).toContain('paused');
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
    expect(labels(known)).toContain('Show both halves');
    document.body.innerHTML = '';
    // both halves deleted: the search would find nothing, so no button is drawn
    const gone = await render(
      <PlanExecuteSection pairs={asyncState({ pairs: rows })} tasks={[]} onChanged={() => {}} onFindInTasks={() => {}} />,
    );
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
    expect(textOf(c.querySelector('[role="alert"]'))).toContain('daemon unreachable');
    expect(c.querySelector('[data-testid="pe-empty"]')).toBeNull();
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
    expect(textOf(c)).toContain('0 3 * * *');
    expect(textOf(c)).toContain('not applied');
  });

  it('disables import when the security preview raises a red flag, with the reason', async () => {
    const c = await renderOffers([
      offer({ id: 'off_red', preview: { flags: [{ level: 'red', text: 'bypassPermissions is banned in H1 — import will be rejected.' }], arrivesDisabled: true } }),
    ]);
    const btn = c.querySelector('[data-testid="offer-import"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(textOf(c.querySelector('[data-testid="offer-blocked"]'))).toContain('the button would only fail');
  });

  it('leaves import enabled for an ordinary offer', async () => {
    const c = await renderOffers([offer()]);
    expect((c.querySelector('[data-testid="offer-import"]') as HTMLButtonElement).disabled).toBe(false);
    expect(c.querySelector('[data-testid="offer-dismiss"]')).not.toBeNull();
  });

  it('draws neither import nor dismiss on an offer that was already decided', async () => {
    const c = await renderOffers([
      offer({ id: 'off_done', status: 'imported', taskId: 'task_new', decidedAt: 1_700_000_100_000 }),
      offer({ id: 'off_gone', status: 'dismissed', decidedAt: 1_700_000_100_000 }),
    ]);
    // the board opens on the offers that still need a decision; these do not
    await click(tabNamed(c, 'all'));
    expect(c.querySelectorAll('[data-testid^="offer-"]').length).toBeGreaterThan(0);
    // both routes CAS on status='offered' and 422 otherwise
    expect(c.querySelector('[data-testid="offer-import"]')).toBeNull();
    expect(c.querySelector('[data-testid="offer-dismiss"]')).toBeNull();
    expect(c.querySelector('[data-testid="offer-find"]')).not.toBeNull();
    expect(textOf(c.querySelector('[data-testid="offer-imported"]'))).toContain('paused task');
  });

  it('admits when an offer carries no security preview instead of implying it is clean', async () => {
    const c = await renderOffers([offer({ id: 'off_raw', preview: null })]);
    expect(textOf(c.querySelector('[data-testid="offer-no-preview"]'))).toContain('Read the prompt above yourself');
  });

  it('explains what the feature is when no repo has been read yet', async () => {
    const c = await renderOffers([]);
    expect(textOf(c.querySelector('[data-testid="rj-empty"]'))).toContain('.clockwork/jobs.json');
    expect((c.querySelector('[data-testid="rj-scan"]') as HTMLButtonElement).disabled, 'no path, no scan').toBe(true);
  });

  it('surfaces a failed listing rather than showing an empty, reassuring page', async () => {
    stubRoutes({ '/workforce/repo-jobs': () => new Response(JSON.stringify({ error: 'no such table' }), { status: 500 }) });
    const { default: RepoJobsSection } = await import('../src/components/RepoJobsSection');
    const c = await render(<RepoJobsSection version={1} onFindInTasks={() => {}} onTasksChanged={() => {}} />);
    expect(textOf(c.querySelector('[role="alert"]'))).toContain('no such table');
    expect(c.querySelector('[data-testid="rj-empty"]')).toBeNull();
  });
});
