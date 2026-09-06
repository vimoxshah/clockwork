/**
 * F1 plan-then-execute, inside Tasks.
 *
 * One booking becomes two tasks: a PLAN half that runs once at a human hour
 * and writes a plan, and an EXECUTE half that stays paused until a human
 * approves THAT plan. The daemon could create pairs from the day it shipped;
 * nothing in the app could, so this section is the creation surface and the
 * status board for them.
 *
 * WHAT IS DELIBERATELY NOT DRAWN HERE
 *   `POST /workforce/plan-execute/:id/resolve` accepts a verdict ONLY while
 *   the pair is `awaiting_approval`; every other status answers 409
 *   `already_resolved` (plan-execute.ts:292-307). So Approve/Reject render for
 *   that one status and nowhere else — including `awaiting_plan`, where
 *   approving would mean approving a plan nobody has written yet.
 */
import { useMemo, useState } from 'react';
import { api, type PlanExecutePairT, type PlanExecuteStatusT, type TaskViewT } from '../api';
import type { AsyncState } from '../useAsync';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { fmtWhen, openInbox, openRunInInbox } from './workforce-common';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * Mounted as a Tasks section (see TasksView's segmented switch). The anchor
 * lives on that switch's button — always rendered regardless of which
 * section is currently selected — not inside this section itself, which only
 * mounts when 'pairs' is the active section.
 */
export const PLAN_EXECUTE_SURFACE = registerFeatureSurface({
  key: 'plan_then_execute',
  tab: 'tasks',
  where: 'Tasks › Plan → execute',
  anchorId: 'plan-execute',
});

type StatusFilter = 'all' | PlanExecuteStatusT;

const STATUS_FILTERS: StatusFilter[] = ['all', 'awaiting_plan', 'awaiting_approval', 'approved', 'executed', 'rejected'];

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'all',
  awaiting_plan: 'planning',
  awaiting_approval: 'needs you',
  approved: 'approved',
  executed: 'executed',
  rejected: 'rejected',
};

/** Chip class + human label per status; the prose is per-pair (see `explain`). */
const STATUS_CHIP: Record<PlanExecuteStatusT, { cls: string; label: string }> = {
  awaiting_plan: { cls: 'running', label: 'writing the plan' },
  awaiting_approval: { cls: 'needs-you', label: 'waiting for you' },
  approved: { cls: 'completed', label: 'approved' },
  executed: { cls: 'completed', label: 'executed' },
  rejected: { cls: 'failed', label: 'rejected' },
};

/**
 * What this particular pair is waiting on, in a sentence.
 *
 * Two statuses mean two different things depending on another column, and
 * flattening either one would tell the user something false:
 *   approved + no execute run — the booker REFUSED (a policy rule, or the task
 *     was deleted mid-decision). plan-execute.ts:349 leaves the pair
 *     'approved' with no run, "visible, not silent".
 *   rejected + no approval id — nobody rejected anything; the PLAN RUN itself
 *     failed, so no approval was ever opened (plan-execute.ts:245-254).
 */
export function explainPair(pair: PlanExecutePairT): string {
  switch (pair.status) {
    case 'awaiting_plan':
      return 'The plan run has not produced a plan yet. There is nothing to approve, and the execute half is refused until there is.';
    case 'awaiting_approval':
      return 'The plan is written and waiting for you. Approving books the execute run with that plan bound into it; rejecting closes the pair and books nothing. Nothing expires.';
    case 'approved':
      return pair.executeRunId
        ? 'You approved the plan and the execute run was booked.'
        : 'You approved the plan, but booking the execute run was refused — a policy rule, or the task was deleted while you were deciding. Nothing ran.';
    case 'executed':
      return 'You approved the plan and Clockwork booked the execute run from it.';
    case 'rejected':
      return pair.approvalId
        ? 'You rejected the plan. Nothing was booked and the pair is closed.'
        : 'The plan run did not complete, so no plan was ever offered for approval. The pair is closed.';
  }
}

export default function PlanExecuteSection({
  pairs,
  tasks,
  onChanged,
  onFindInTasks,
}: {
  /** lifted to TasksView: the task rows need the same pairs to gate their buttons */
  pairs: AsyncState<{ pairs: PlanExecutePairT[] }>;
  tasks: TaskViewT[];
  onChanged: () => void;
  onFindInTasks: (query: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = pairs.data?.pairs ?? [];
  const visible = filter === 'all' ? rows : rows.filter((p) => p.status === filter);
  const nameOf = (taskId: string): string | null => tasks.find((t) => t.id === taskId)?.name ?? null;

  /** Tasks already used by a pair are not offered as a source for another one. */
  const usedTaskIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of rows) {
      set.add(p.planTaskId);
      set.add(p.executeTaskId);
    }
    return set;
  }, [rows]);

  return (
    <div>
      <div className="tasks-toolbar">
        <div className="grow">
          <h3 className="section-title" style={{ margin: 0 }}>Plan, then execute</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            One booking becomes two runs. The plan half runs at an hour you are awake and writes a plan;
            the execute half stays paused until you approve that plan, and then Clockwork books it for you.
          </p>
        </div>
        <button className="btn primary small" onClick={() => setCreating(true)} data-testid="pe-new">
          New pair
        </button>
        <button className="btn small" onClick={pairs.reload} aria-label="Refresh pairs">⟳</button>
      </div>

      {notice && <div className="ok-banner">{notice}</div>}

      <div className="filter-chips" role="tablist" aria-label="Filter pairs by status">
        {STATUS_FILTERS.map((f) => {
          const n = f === 'all' ? rows.length : rows.filter((p) => p.status === f).length;
          return (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} {n}
            </button>
          );
        })}
      </div>

      {pairs.loading && <div className="state-line"><span className="spinner" /> Loading pairs…</div>}
      {pairs.error && (
        <div className="error-banner" role="alert">
          Couldn’t load plan-execute pairs: {pairs.error}
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={pairs.reload}>Retry</button></div>
        </div>
      )}

      {!pairs.loading && !pairs.error && rows.length === 0 && (
        <div className="empty" data-testid="pe-empty">
          No plan-execute pairs yet.
          <p className="hint">
            Use one when you want to read the agent’s plan before it touches anything: pick an existing task,
            choose the hour you want the plan ready by, and Clockwork clones it into a plan half and a paused
            execute half. “New pair” above builds the first one.
          </p>
        </div>
      )}
      {!pairs.loading && !pairs.error && rows.length > 0 && visible.length === 0 && (
        <div className="empty">
          No pairs are {FILTER_LABEL[filter]}.
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={() => setFilter('all')}>Show all</button></div>
        </div>
      )}

      {visible.map((p) => (
        <PairRow
          key={p.id}
          pair={p}
          planName={nameOf(p.planTaskId)}
          executeName={nameOf(p.executeTaskId)}
          onResolved={(msg) => {
            setNotice(msg);
            setTimeout(() => setNotice(null), 5000);
            onChanged();
          }}
          onFindInTasks={onFindInTasks}
        />
      ))}

      {creating && (
        <CreatePairDialog
          tasks={tasks.filter((t) => !usedTaskIds.has(t.id))}
          excludedCount={tasks.filter((t) => usedTaskIds.has(t.id)).length}
          onClose={() => setCreating(false)}
          onCreated={(msg) => {
            setCreating(false);
            setNotice(msg);
            setTimeout(() => setNotice(null), 6000);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function PairRow({
  pair,
  planName,
  executeName,
  onResolved,
  onFindInTasks,
}: {
  pair: PlanExecutePairT;
  planName: string | null;
  executeName: string | null;
  onResolved: (msg: string) => void;
  onFindInTasks: (query: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chip = STATUS_CHIP[pair.status];
  const decidable = pair.status === 'awaiting_approval';

  const resolve = async (decision: 'approved' | 'rejected'): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.planExecuteResolve(pair.id, decision);
      onResolved(
        decision === 'rejected'
          ? 'Plan rejected — the pair is closed and nothing was booked.'
          : res.executeRunId
            ? 'Plan approved — the execute run is booked. Watch it in the calendar or the inbox.'
            : 'Plan approved, but booking the execute run was refused (a policy rule, or the task is gone). Nothing ran.',
      );
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // The halves are named "<source> — plan" / "<source> — execute"
  // (plan-execute.ts:152), so the source name finds both rows in the task
  // search. If a half was renamed, this degrades to finding that one row — and
  // when neither half is in the task list any more (deleted), the search would
  // find nothing, so the button is not drawn at all.
  const searchTerm = planName
    ? planName.replace(/\s+—\s+plan$/, '')
    : executeName
      ? executeName.replace(/\s+—\s+execute$/, '')
      : null;

  return (
    <div className="tasklist-row" style={{ display: 'block' }} data-testid={`pair-${pair.status}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className={`chip ${chip.cls}`}>{chip.label}</span>
        <strong className="grow">{planName ?? <span className="mono">{pair.planTaskId}</span>}</strong>
        <span className="hint mono" style={{ margin: 0 }}>created {fmtWhen(pair.createdAt)}</span>
      </div>

      <div className="hint" style={{ marginTop: 4 }}>{explainPair(pair)}</div>
      <div className="hint" style={{ marginTop: 2 }}>
        plan half: {planName ?? <span className="mono">{pair.planTaskId}</span>}
        {' · '}execute half: {executeName ?? <span className="mono">{pair.executeTaskId}</span>}
        {pair.decidedAt ? ` · decided ${fmtWhen(pair.decidedAt)}` : ''}
      </div>

      {err && <div className="error-banner" role="alert">{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {decidable && (
          <>
            <button
              className="btn primary small"
              disabled={busy}
              data-testid="pair-approve"
              onClick={() => void resolve('approved')}
            >
              Approve &amp; book execute run
            </button>
            <button className="btn danger small" disabled={busy} data-testid="pair-reject" onClick={() => void resolve('rejected')}>
              Reject plan
            </button>
          </>
        )}
        {pair.planRunId && (
          <button className="btn small" onClick={() => openRunInInbox(pair.planRunId!)}>
            {decidable ? 'Read the plan' : 'Open plan run'}
          </button>
        )}
        {decidable && !pair.planRunId && (
          <button className="btn small" onClick={openInbox}>Open the inbox</button>
        )}
        {pair.executeRunId && (
          <button className="btn small" onClick={() => openRunInInbox(pair.executeRunId!)}>Open execute run</button>
        )}
        {searchTerm && (
          <button className="btn small" onClick={() => onFindInTasks(searchTerm)}>Show both halves</button>
        )}
      </div>
    </div>
  );
}

/** 0…23 as "00:00"…"23:00" — the daemon takes an integer hour, nothing finer. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function CreatePairDialog({
  tasks,
  excludedCount,
  onClose,
  onCreated,
}: {
  tasks: TaskViewT[];
  excludedCount: number;
  onClose: () => void;
  onCreated: (msg: string) => void;
}): JSX.Element {
  const [taskId, setTaskId] = useState('');
  const [planHour, setPlanHour] = useState('9');
  // The daemon 422s a zone luxon cannot resolve, so start from the one the
  // browser reports rather than guessing UTC for everybody.
  const [tz, setTz] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const source = tasks.find((t) => t.id === taskId) ?? null;

  const create = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.planExecuteCreate({ taskId, planHour: Number(planHour), tz: tz.trim() });
      onCreated(
        `Pair created from “${source?.name ?? taskId}”. The plan half runs at ${planHour.padStart(2, '0')}:00 ${tz.trim()}; ` +
          'the execute half is paused until you approve that plan.',
      );
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New plan-then-execute pair</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          Clockwork copies an existing task into two: a plan half that runs once and changes nothing, and an
          execute half that stays paused until you approve the plan it wrote. The original task is left alone.
        </p>

        {tasks.length === 0 ? (
          <div className="empty" data-testid="pe-no-source">
            No task can seed a pair right now.
            <p className="hint">
              {excludedCount > 0
                ? `All ${excludedCount} of your tasks are already halves of a pair — a half is not a source for another pair. Create an ordinary task first.`
                : 'Create a task first (the “+ New task” tab), then come back and build the pair from it.'}
            </p>
          </div>
        ) : (
          <>
            <label className="f">Build the pair from</label>
            <Select value={taskId || '__none__'} onValueChange={(v) => setTaskId(v === '__none__' ? '' : v)}>
              <SelectTrigger aria-label="Source task" data-testid="pe-task-select">
                <SelectValue placeholder="— pick a task —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— pick a task —</SelectItem>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {excludedCount > 0 && (
              <p className="hint">
                {excludedCount} task{excludedCount === 1 ? ' is' : 's are'} not listed: they are already halves of a pair.
              </p>
            )}

            <div className="row2" style={{ marginTop: 10 }}>
              <div>
                <label className="f">Have the plan ready by</label>
                <Select value={planHour} onValueChange={setPlanHour}>
                  <SelectTrigger aria-label="Plan hour"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="f" htmlFor="pe-tz">Time zone</label>
                <input id="pe-tz" className="mono" type="text" value={tz} onChange={(e) => setTz(e.target.value)} />
              </div>
            </div>
            <p className="hint">
              The plan half runs once, at the next {planHour.padStart(2, '0')}:00 in that zone, in plan mode —
              it reads and writes a plan, and changes nothing.
            </p>

            {source && (
              <p className="hint">
                Creates “{source.name} — plan” and “{source.name} — execute”. The execute half keeps this task’s
                permission mode ({source.permissionMode}) and budget (${source.budget.maxUsd}), and arrives paused.
              </p>
            )}
          </>
        )}

        {err && <div className="error-banner" role="alert">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={busy || !taskId || !tz.trim()}
            data-testid="pe-create"
            onClick={() => void create()}
          >
            Create pair
          </button>
        </div>
      </div>
    </div>
  );
}
