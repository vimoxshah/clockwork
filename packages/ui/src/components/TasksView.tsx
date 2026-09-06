/**
 * Tasks (FR-5/FR-6): first-class task management surface.
 * Full-width layout, instant multi-field search (name / prompt / repo /
 * provider), status filters, windowed rendering for 500+ tasks.
 *
 * THREE WORKFORCE FEATURES LIVE HERE AS SECTIONS, NOT AS TABS.
 * App.tsx's own map puts plan-then-execute (F1), sentinels (F4) and
 * repo-shipped jobs (F5) under Tasks, because all three CREATE AND HOLD WORK —
 * that is what this screen is for. They are sections behind one segmented
 * switch rather than four scrolling blocks on one page: the task list is the
 * daily surface and must not be pushed below three feature panels, and each
 * section owns its own fetch, so a failing sentinel request cannot blank the
 * task list. They did not earn tabs in the shell for the reason App.tsx gives:
 * a tab per feature turns the shell into a table of contents for our backlog.
 *
 * THE ONE THING THIS VIEW MUST GET RIGHT: THE EXECUTE HALF.
 * The execute half of an F1 pair is an ordinary-looking paused task, and it is
 * not one. `PATCH {enabled:true}` is refused at EVERY pair status, and
 * `run-now` is refused unless a human has approved that specific plan
 * (daemon api.ts:320-340, ADR-039) — both with a 409. This view drew Enable
 * and Run now on those rows anyway, so every click was a guaranteed failure.
 * The pair list is fetched alongside the tasks and the row asks it what the
 * daemon would answer, before drawing a button.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type PlanExecutePairT, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { ConfirmDialog } from './ConfirmDialog';
import PlanExecuteSection from './PlanExecuteSection';
import SentinelsSection from './SentinelsSection';
import RepoJobsSection from './RepoJobsSection';
import { openInbox, openRunInInbox } from './workforce-common';

type StatusFilter = 'all' | 'active' | 'paused';
type SortKey = 'name' | 'recent';
type Section = 'tasks' | 'pairs' | 'sentinels' | 'repo';

/** Windowed rendering: only a slice of rows mounts at once (5k+ tasks stay smooth). */
const PAGE_SIZE = 100;

const SECTION_KEY = 'clockwork.tasks.section';
const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'tasks', label: 'tasks' },
  { key: 'pairs', label: 'plan → execute' },
  { key: 'sentinels', label: 'sentinels' },
  { key: 'repo', label: 'repo jobs' },
];

/** Which half of a plan-then-execute pair a task row is, if any. */
export type PairRole = 'plain' | 'plan' | 'execute';

/**
 * What the daemon will accept for the EXECUTE half of a pair in this state.
 *
 * `enable` is refused at every status without exception — resolving the pair
 * books the execute run directly, so `enabled=1` could only mean "let a later
 * plan run fire this half carrying a plan nobody read". `run` is refused
 * unless a human has read and approved THAT plan; 'approved' and 'executed'
 * both mean they did, so a manual re-run is theirs to make (daemon
 * api.ts:320-345).
 */
export function executeHalfGate(pair: PlanExecutePairT): {
  chipClass: string;
  chipLabel: string;
  why: string;
  canRunNow: boolean;
} {
  switch (pair.status) {
    case 'awaiting_plan':
      return {
        chipClass: 'running',
        chipLabel: 'waiting on its plan',
        why: 'The execute half of a plan-then-execute pair. Its plan run has not produced a plan yet, so there is nothing to approve and nothing to run.',
        canRunNow: false,
      };
    case 'awaiting_approval':
      return {
        chipClass: 'needs-you',
        chipLabel: 'waiting on your approval',
        why: 'The execute half of a plan-then-execute pair. The plan is written and waiting for you — approving it books this run, so you never start it by hand.',
        canRunNow: false,
      };
    case 'approved':
      return {
        chipClass: 'completed',
        chipLabel: 'plan approved',
        why: pair.executeRunId
          ? 'The execute half of a plan-then-execute pair. You approved the plan and the run was booked.'
          // `bookRun` returns null in exactly two cases (daemon api.ts:281-291):
          // the task row is gone, or the policy engine refused it. A paused
          // daemon is NOT one of them — enqueueRunNow still writes the run.
          : 'The execute half of a plan-then-execute pair. You approved the plan, but booking the run was refused — a policy rule, or the task was deleted while you were deciding. Nothing ran; starting it by hand is allowed now.',
        canRunNow: true,
      };
    case 'executed':
      return {
        chipClass: 'completed',
        chipLabel: 'plan approved',
        why: 'The execute half of a plan-then-execute pair. You approved the plan and Clockwork booked the run from it.',
        canRunNow: true,
      };
    case 'rejected':
      return {
        chipClass: 'failed',
        chipLabel: 'plan rejected',
        why: pair.approvalId
          ? 'The execute half of a plan-then-execute pair. You rejected the plan, so this half stays refused. Build a new pair to try again.'
          : 'The execute half of a plan-then-execute pair. Its plan run never finished, so no plan was ever offered and this half stays refused. Build a new pair to try again.',
        canRunNow: false,
      };
  }
}

export default function TasksView({ version }: { version: number }): JSX.Element {
  const tasks = useAsync(() => api.tasks(), [version]);
  const queue = useAsync(() => api.queue(), [version]);
  // F1: fetched HERE, not inside the pairs section — the task rows need the
  // same answer to decide whether Run now / Enable can succeed at all.
  const pairs = useAsync(() => api.planExecuteList(), [version]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskViewT | null>(null);
  const [deleting, setDeleting] = useState<TaskViewT | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [section, setSection] = useState<Section>(() => {
    const saved = localStorage.getItem(SECTION_KEY) as Section | null;
    return saved && SECTIONS.some((s) => s.key === saved) ? saved : 'tasks';
  });

  useEffect(() => setVisibleCount(PAGE_SIZE), [q, status, sort]);
  useEffect(() => localStorage.setItem(SECTION_KEY, section), [section]);

  /**
   * Task id → its pair. First write wins: `planExecuteList` is ordered newest
   * first and the daemon's own lookup takes the newest row for a task, so the
   * two agree about which pair governs a row.
   */
  const { byExecuteTask, byPlanTask, awaitingApproval } = useMemo(() => {
    const ex = new Map<string, PlanExecutePairT>();
    const pl = new Map<string, PlanExecutePairT>();
    let waiting = 0;
    for (const p of pairs.data?.pairs ?? []) {
      if (!ex.has(p.executeTaskId)) ex.set(p.executeTaskId, p);
      if (!pl.has(p.planTaskId)) pl.set(p.planTaskId, p);
      if (p.status === 'awaiting_approval') waiting++;
    }
    return { byExecuteTask: ex, byPlanTask: pl, awaitingApproval: waiting };
  }, [pairs.data]);

  const filtered = useMemo(() => {
    let rows = [...(tasks.data ?? [])];
    if (status === 'active') rows = rows.filter((t) => t.enabled);
    else if (status === 'paused') rows = rows.filter((t) => !t.enabled);
    const term = q.trim().toLowerCase();
    if (term) {
      rows = rows.filter((t) =>
        t.name.toLowerCase().includes(term) ||
        t.prompt.toLowerCase().includes(term) ||
        (t.repoPath ?? '').toLowerCase().includes(term) ||
        String(t.engine ?? '').toLowerCase().includes(term));
    }
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else rows.sort((a, b) => String(b.id).localeCompare(String(a.id))); // ULID ids are time-ordered
    return rows;
  }, [tasks.data, q, status, sort]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
    setActionErr(null);
    try {
      await fn();
      if (okMsg) {
        setNotice(okMsg);
        setTimeout(() => setNotice(null), 4000);
      }
      tasks.reload();
      queue.reload();
    } catch (e) {
      setActionErr(String((e as Error).message ?? e));
    }
  };

  /** Jump back to the list with a search that finds what the caller means. */
  const findInTasks = (query: string): void => {
    setQ(query);
    setStatus('all');
    setSection('tasks');
  };

  // The pair lookup decides which buttons a row may draw, so rows wait for it.
  // A FAILED lookup is different from a slow one: hiding every action because
  // one request failed is worse than the bug being fixed, so the rows render
  // and the banner below says plainly what could not be checked.
  const rowsReady = !tasks.loading && !tasks.error && !pairs.loading;

  return (
    <div className="tasks-page">
      <div className="seg" role="tablist" aria-label="Tasks sections" style={{ marginBottom: 10 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={section === s.key}
            className={section === s.key ? 'on' : ''}
            data-testid={`section-${s.key}`}
            onClick={() => setSection(s.key)}
          >
            {s.label}
            {s.key === 'pairs' && awaitingApproval > 0 ? ` · ${awaitingApproval} need you` : ''}
          </button>
        ))}
      </div>

      {section === 'pairs' && (
        <PlanExecuteSection
          pairs={pairs}
          tasks={tasks.data ?? []}
          onChanged={() => {
            pairs.reload();
            tasks.reload();
          }}
          onFindInTasks={findInTasks}
        />
      )}
      {section === 'sentinels' && <SentinelsSection version={version} tasks={tasks.data ?? []} />}
      {section === 'repo' && (
        <RepoJobsSection version={version} onFindInTasks={findInTasks} onTasksChanged={tasks.reload} />
      )}

      {section === 'tasks' && (
        <>
          {/* ---- sticky toolbar: search drives everything ---- */}
          <div className="tasks-toolbar">
            <div className="relative" style={{ flex: 1, minWidth: 260 }}>
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">🔍</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tasks by name, prompt, repo, or provider…"
                aria-label="Search tasks"
                data-testid="task-filter"
                className="inbox-search !pl-9"
                style={{ width: '100%' }}
                autoFocus
              />
              {q && (
                <button
                  onClick={() => setQ('')}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-dim hover:text-fg"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="seg" role="tablist" aria-label="Task status">
              {(['all', 'active', 'paused'] as StatusFilter[]).map((s) => (
                <button key={s} role="tab" aria-selected={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                  {s}
                </button>
              ))}
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger aria-label="Sort tasks" className="w-auto h-8 text-caption">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Newest first</SelectItem>
                <SelectItem value="name">Name A→Z</SelectItem>
              </SelectContent>
            </Select>
            <span className="chip" style={{ whiteSpace: 'nowrap' }} data-testid="task-count">
              {q.trim() || status !== 'all'
                ? `${filtered.length} of ${tasks.data?.length ?? 0}`
                : `${filtered.length} task${filtered.length === 1 ? '' : 's'}`}
            </span>
            <button className="btn small" onClick={() => { tasks.reload(); queue.reload(); pairs.reload(); }} aria-label="Refresh tasks">
              ⟳
            </button>
          </div>

          {notice && <div className="ok-banner">{notice}</div>}
          {actionErr && <div className="error-banner" role="alert">{actionErr}</div>}
          {pairs.error && (
            <div className="error-banner" role="alert" data-testid="pairs-unknown">
              Couldn’t check plan-then-execute pairs: {pairs.error}. Rows are shown without that check, so on the
              execute half of a pair “Run now” and “Enable” may be refused.
              <div><button className="btn small" style={{ marginTop: 8 }} onClick={pairs.reload}>Retry</button></div>
            </div>
          )}

          {/* ---- queue lane ---- */}
          {queue.data && queue.data.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 className="section-title">Queue — waiting to run</h3>
              {queue.error && <div className="error-banner">Couldn’t load queue: {queue.error}</div>}
              {queue.data.map((qi) => (
                <div key={qi.runId} className="tasklist-row" data-testid={`queue-${qi.position}`}>
                  <span className="chip running">#{qi.position}</span>
                  <div className="grow">
                    <strong>{qi.name}</strong>
                    <div className="hint" style={{ margin: 0 }}>{qi.reason}</div>
                  </div>
                  <button className="btn danger small" onClick={() => void act(() => api.cancelRun(qi.runId))}>
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ---- states ---- */}
          {(tasks.loading || (pairs.loading && !tasks.error)) && (
            <div className="state-line"><span className="spinner" /> Loading tasks…</div>
          )}
          {tasks.error && (
            <div className="error-banner" role="alert">
              Couldn’t load tasks: {tasks.error}
              <div><button className="btn small" style={{ marginTop: 8 }} onClick={tasks.reload}>Retry</button></div>
            </div>
          )}
          {rowsReady && (tasks.data ?? []).length === 0 && (
            <div className="empty">
              No tasks yet. Book your first run from the calendar or the “+ New task” tab.
            </div>
          )}
          {rowsReady && (tasks.data ?? []).length > 0 && filtered.length === 0 && (
            <div className="empty">
              No tasks match “{q.trim()}”{status !== 'all' ? ` (${status})` : ''}.
              <div><button className="btn small" style={{ marginTop: 8 }} onClick={() => { setQ(''); setStatus('all'); }}>Clear filters</button></div>
            </div>
          )}

          {/* ---- list ---- */}
          {rowsReady && (
            <div className="tasklist">
              {filtered.slice(0, visibleCount).map((t) => {
                const executePair = byExecuteTask.get(t.id) ?? null;
                const planPair = byPlanTask.get(t.id) ?? null;
                return (
                  <TaskRow
                    key={t.id}
                    task={t}
                    role={executePair ? 'execute' : planPair ? 'plan' : 'plain'}
                    pair={executePair ?? planPair}
                    onRunNow={() => void act(() => api.runNow(t.id), `Run queued for “${t.name}” — watch the calendar or inbox.`)}
                    onToggle={() => void act(() => api.patchTask(t.id, { enabled: !t.enabled, version: t.version }))}
                    onEdit={() => setEditing(t)}
                    onDelete={() => setDeleting(t)}
                    onReviewPlan={() => {
                      if (executePair?.planRunId) openRunInInbox(executePair.planRunId);
                      else openInbox();
                    }}
                    onViewPair={() => setSection('pairs')}
                  />
                );
              })}
            </div>
          )}
          {rowsReady && visibleCount < filtered.length && (
            <button className="btn small" style={{ marginTop: 12 }} onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} data-testid="task-more">
              Show {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more ({filtered.length - visibleCount} hidden)
            </button>
          )}
        </>
      )}

      {editing && (
        <EditDialog
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg: string) => {
            setEditing(null);
            setNotice(msg);
            setTimeout(() => setNotice(null), 4000);
            tasks.reload();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="The task is soft-deleted: history and reports are kept, future occurrences stop immediately."
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteTask(deleting.id);
            setDeleting(null);
            tasks.reload();
            pairs.reload();
          }}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  role,
  pair,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
  onReviewPlan,
  onViewPair,
}: {
  task: TaskViewT;
  role: PairRole;
  pair: PlanExecutePairT | null;
  onRunNow: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReviewPlan: () => void;
  onViewPair: () => void;
}): JSX.Element {
  // The execute half is the whole reason this row has a gate: Enable is a 409
  // at every pair status, and Run now is a 409 until a human approved THAT
  // plan. Neither button is drawn where it cannot succeed.
  const gate = role === 'execute' && pair ? executeHalfGate(pair) : null;

  return (
    <div className="tasklist-row" data-testid={gate ? 'task-row-execute-half' : 'task-row'}>
      <div className="grow">
        <strong>
          {task.name}{' '}
          {gate ? (
            <span className={`chip ${gate.chipClass}`}>{gate.chipLabel}</span>
          ) : (
            !task.enabled && <span className="chip failed">paused</span>
          )}
          {role === 'plan' && <span className="chip">plan half</span>}
        </strong>
        <div className="hint" style={{ margin: 0 }}>
          next {task.enabled ? (task.nextFire ? new Date(task.nextFire).toLocaleString() : '—') : '—'}
          {' · '}${task.budget.maxUsd} · {task.permissionMode}
          {task.repoPath ? ` · ${task.repoPath}` : ' · scratch'}
        </div>
        {gate && (
          <div className="hint" style={{ marginTop: 4 }} data-testid="execute-half-reason">
            {gate.why} It stays paused on purpose: switching it on would let a later plan run start it carrying a
            plan nobody read.
          </div>
        )}
        {role === 'plan' && (
          <div className="hint" style={{ marginTop: 4 }}>
            The plan half of a plan-then-execute pair. Its report is the plan you approve.
          </div>
        )}
      </div>
      {(!gate || gate.canRunNow) && (
        <button className="btn primary small" onClick={onRunNow}>
          Run now
        </button>
      )}
      {!gate && (
        <button className="btn small" onClick={onToggle}>
          {task.enabled ? 'Pause' : 'Enable'}
        </button>
      )}
      {gate && pair && (
        <button
          className="btn small"
          data-testid="execute-half-link"
          onClick={pair.status === 'awaiting_approval' ? onReviewPlan : onViewPair}
        >
          {pair.status === 'awaiting_approval' ? 'Review the plan' : 'See the pair'}
        </button>
      )}
      {role === 'plan' && (
        <button className="btn small" onClick={onViewPair}>See the pair</button>
      )}
      <button className="btn small" onClick={onEdit}>
        Edit
      </button>
      <button className="btn danger small" onClick={onDelete} aria-label={`Delete ${task.name}`}>
        Delete
      </button>
    </div>
  );
}

function EditDialog({
  task,
  onClose,
  onSaved,
}: {
  task: TaskViewT;
  onClose: () => void;
  onSaved: (msg: string) => void;
}): JSX.Element {
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt);
  const [maxUsd, setMaxUsd] = useState(String(task.budget.maxUsd));
  const [maxTurns, setMaxTurns] = useState(String(task.budget.maxTurns));
  const [timeoutSec, setTimeoutSec] = useState(String(task.budget.timeoutSec));
  const [permissionMode, setPermissionMode] = useState(task.permissionMode);
  const [chainAfter, setChainAfter] = useState<string | null>(task.chainAfter ?? null);
  const [chainOn, setChainOn] = useState<string>(task.chainOn ?? 'completed');
  // sibling tasks offered as upstream (excluding self)
  const [allTasks, setAllTasks] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api.tasks().then((rows) => setAllTasks(rows.filter((t) => t.id !== task.id).map((t) => ({ id: t.id, name: t.name })))).catch(() => {});
  }, [task.id]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.patchTask(task.id, {
        name,
        prompt,
        permissionMode,
        chainAfter,
        chainOn: chainAfter ? chainOn : undefined,
        budget: { maxUsd: Number(maxUsd) || task.budget.maxUsd, maxTurns: Number(maxTurns) || task.budget.maxTurns, timeoutSec: Number(timeoutSec) || task.budget.timeoutSec },
        version: task.version,
      });
      onSaved('Task saved.');
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setErr(msg.includes('409') || msg.includes('conflict') ? 'This task changed elsewhere — reopen and retry.' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Edit task</h3>
        <label className="f">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="f">Prompt</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row3">
          <div>
            <label className="f">Budget USD</label>
            <input type="number" min="0.1" step="0.5" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} />
          </div>
          <div>
            <label className="f">Max turns</label>
            <input type="number" min="1" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
          </div>
          <div>
            <label className="f">Timeout s</label>
            <input type="number" min="30" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
          </div>
        </div>
        <label className="f">Permission mode</label>
        <Select value={permissionMode} onValueChange={setPermissionMode}>
          <SelectTrigger aria-label="Permission mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="plan">plan (dry-run)</SelectItem>
            <SelectItem value="acceptEdits">acceptEdits</SelectItem>
          </SelectContent>
        </Select>

        <label className="f">Chain after (run when that task finishes)</label>
        <Select
          value={chainAfter ?? '__none__'}
          onValueChange={(v) => setChainAfter(v === '__none__' ? null : v)}
        >
          <SelectTrigger aria-label="Chain after"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— none —</SelectItem>
            {allTasks
              .filter((t) => t.id !== task.id)
              .map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
          </SelectContent>
        </Select>
        {chainAfter && (
          <>
            <label className="f">Fire when upstream is…</label>
            <Select value={chainOn} onValueChange={setChainOn}>
              <SelectTrigger aria-label="Chain trigger"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="completed">completed (recommended)</SelectItem>
                <SelectItem value="any_terminal">any terminal state</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
        {err && <div className="error-banner">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export { ConfirmDialog };
