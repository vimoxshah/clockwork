/**
 * F1 recovery on the pair board: retrying a booking the daemon refused (T1-11).
 *
 * THE BUG THESE TESTS EXIST FOR. Approving a plan commits the verdict first
 * and books the execute run second. When that booking is refused — a policy
 * rule, an execute half deleted mid-decision, a booker that throws — the pair
 * stops at `approved` with no execute run. The board said so in a sentence and
 * then offered nothing: the inbox item was closed, the `plan_execute
 * .book_rejected` audit line sits behind a 402 route with no screen, and the
 * resolve route answered 409. The approval a human gave produced no work and
 * no way to ask again.
 *
 * WHAT IS ASSERTED HERE
 *   1. The affordance appears on that shape and on NO other. Drawing "Retry
 *      booking" on a pair nobody approved would be a request the daemon
 *      refuses — the same guaranteed-failure button F1's task rows already
 *      had to lose.
 *   2. Clicking it sends the ORIGINAL verdict again, on the resolve route.
 *      The daemon reads a second `approved` on a stranded pair as a retry of
 *      the booking and re-binds the approved plan into the prompt itself.
 *   3. It is never presented as *Run now*. Run now on the execute half is
 *      allowed at this status and would start the task from its stored
 *      prompt, with the plan placeholder unrendered — the agent would work
 *      without the plan. The row has to say so.
 *   4. Both answers are reported honestly: booked, or refused again.
 *
 * jsdom + createRoot, the approach the other UI suites use. Only `fetch` is
 * stubbed; the real api client builds the request, so a renamed route or a
 * changed body fails here.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanExecutePairT } from '../src/api';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PLAN_EXECUTE_SRC = readFileSync(resolvePath(SRC, 'components/PlanExecuteSection.tsx'), 'utf8');

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];

/** Records every request and answers each one with `answer`. */
function stubFetch(answer: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({
        method: String(init.method),
        path: String(path),
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return answer();
    }),
  );
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function pair(over: Partial<PlanExecutePairT> = {}): PlanExecutePairT {
  return {
    id: 'pair_1',
    planTaskId: 'task_plan',
    executeTaskId: 'task_exec',
    planRunId: 'run_plan',
    approvalId: 'appr_1',
    executeRunId: null,
    status: 'awaiting_plan',
    decidedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/** The pair this whole file is about: approved, decided, and never booked. */
const STRANDED = pair({ id: 'pair_stranded', status: 'approved', executeRunId: null, decidedAt: 1_700_000_001_000 });

function asyncState<T>(data: T) {
  return { data, loading: false, error: null as string | null, reload: (): void => {} };
}

const render = renderComponent;

const textOf = (el: Element | null): string => el?.textContent ?? '';
const labels = (el: Element): string[] => [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

/** React 18 flushes a discrete event's state update before `click()` returns. */
function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
}

async function mount(
  rows: PlanExecutePairT[],
  over: { onChanged?: () => void } = {},
): Promise<HTMLDivElement> {
  const { default: PlanExecuteSection } = await import('../src/components/PlanExecuteSection');
  return render(
    <PlanExecuteSection
      pairs={asyncState({ pairs: rows })}
      tasks={[]}
      onChanged={over.onChanged ?? ((): void => {})}
      onFindInTasks={(): void => {}}
    />,
  );
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.location.hash = '';
});

// ---------------------------------------------------------------------------
describe('the retry affordance appears on the stranded pair and nowhere else', () => {
  it('draws “Retry booking” only for a pair approved with no execute run', async () => {
    const c = await mount([
      pair({ id: 'p_plan', status: 'awaiting_plan' }),
      pair({ id: 'p_gate', status: 'awaiting_approval' }),
      pair({ id: 'p_booked', status: 'approved', executeRunId: 'run_x', decidedAt: 1 }),
      STRANDED,
      pair({ id: 'p_done', status: 'executed', executeRunId: 'run_y', decidedAt: 1 }),
      pair({ id: 'p_no', status: 'rejected', decidedAt: 1 }),
    ]);
    await waitForElement(c, '[data-testid="pair-awaiting_approval"]');

    const retries = c.querySelectorAll('[data-testid="pair-retry"]');
    expect(retries).toHaveLength(1);

    // …and it is on the refused row, not on the approved row that DID book.
    const row = retries[0]!.closest('.tasklist-row')!;
    expect(textOf(row)).toContain('was refused');
    expect(textOf(row)).not.toContain('the execute run was booked');
  });

  it('offers no verdict on the stranded pair — the verdict is already recorded', async () => {
    const c = await mount([STRANDED]);
    const retry = await waitForElement(c, '[data-testid="pair-retry"]');
    const row = retry.closest('.tasklist-row')!;

    expect(row.querySelector('[data-testid="pair-approve"]')).toBeNull();
    expect(row.querySelector('[data-testid="pair-reject"]')).toBeNull();
    expect(labels(row)).toContain('Retry booking');
  });

  it('says plainly that Run now is not the same recovery', async () => {
    const c = await mount([STRANDED]);
    const retry = await waitForElement(c, '[data-testid="pair-retry"]');
    const row = textOf(retry.closest('.tasklist-row'));

    expect(row).toContain('“Run now” on the execute half is not the same recovery');
    expect(row).toContain('without the plan');
    // The board must not offer that path itself, under any label.
    expect(labels(retry.closest('.tasklist-row')!)).not.toContain('Run now');
    expect(PLAN_EXECUTE_SRC, 'the pair board must never book through /tasks/:id/run-now').not.toContain('api.runNow');
  });

  it('explainPair still calls the stranded pair refused, and names the retry', async () => {
    const { explainPair } = await import('../src/components/PlanExecuteSection');
    const refused = explainPair(STRANDED);
    expect(refused).toContain('was refused');
    expect(refused).toContain('Retry booking');
    expect(refused).toContain('with the plan bound into the prompt');
    // the booked pair keeps its own, unchanged sentence
    expect(explainPair(pair({ status: 'approved', executeRunId: 'run_x' }))).toContain('was booked');
    expect(explainPair(pair({ status: 'approved', executeRunId: 'run_x' }))).not.toContain('Retry booking');
  });
});

// ---------------------------------------------------------------------------
describe('clicking it re-sends the approval the human already gave', () => {
  it('POSTs the same decision to the resolve route, once', async () => {
    stubFetch(() => json({ ...STRANDED, status: 'executed', executeRunId: 'run_exec' }));
    const c = await mount([STRANDED]);
    click(await waitForElement(c, '[data-testid="pair-retry"]'));

    await waitForText(c, 'Booked —');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/workforce/plan-execute/pair_stranded/resolve',
      body: { decision: 'approved' },
    });
  });

  it('reports the booked run as carrying the approved plan, and reloads the board', async () => {
    let changed = 0;
    stubFetch(() => json({ ...STRANDED, status: 'executed', executeRunId: 'run_exec' }));
    const c = await mount([STRANDED], { onChanged: () => { changed += 1; } });
    click(await waitForElement(c, '[data-testid="pair-retry"]'));

    const banner = await waitForElement(c, '.ok-banner');
    expect(textOf(banner)).toContain('carries the plan you approved');
    expect(changed).toBe(1);
  });

  it('reports a second refusal as nothing-ran, without pretending the approval is lost', async () => {
    let changed = 0;
    stubFetch(() => json({ ...STRANDED })); // still approved, still no run
    const c = await mount([STRANDED], { onChanged: () => { changed += 1; } });
    click(await waitForElement(c, '[data-testid="pair-retry"]'));

    const banner = await waitForElement(c, '.ok-banner');
    expect(textOf(banner)).toContain('Still refused');
    expect(textOf(banner)).toContain('Your approval stands');
    expect(textOf(banner)).not.toContain('carries the plan you approved');
    expect(changed).toBe(1);
  });

  it('surfaces a daemon refusal on the row instead of claiming a booking', async () => {
    stubFetch(() => json({ error: 'already_resolved' }, 409));
    const c = await mount([STRANDED]);
    click(await waitForElement(c, '[data-testid="pair-retry"]'));

    const alert = await waitForElement(c, '[role="alert"]');
    expect(textOf(alert)).toContain('already_resolved');
    expect(c.querySelector('.ok-banner')).toBeNull();
  });
});
