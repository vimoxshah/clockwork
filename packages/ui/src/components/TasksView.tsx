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
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, type PlanExecutePairT, type RunRowT, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { ConfirmDialog } from './ConfirmDialog';
import PlanExecuteSection from './PlanExecuteSection';
import { PLAN_EXECUTE_SURFACE } from './PlanExecuteSection';
import SentinelsSection from './SentinelsSection';
import { SENTINEL_SURFACE } from './SentinelsSection';
import RepoJobsSection from './RepoJobsSection';
import { REPO_JOBS_SURFACE } from './RepoJobsSection';
import { openInbox, openRunInInbox } from './workforce-common';
import { registerFeatureSurface } from './featureSurfaces';
import { chipFor, stateLabel } from '../lib/runState';

/**
 * Chaining is created and edited here (EditDialog's "Chain after" picker,
 * which sends `chainAfter`/`chainOn` via `api.patchTask`) — the Composer's
 * own "Chain after" select (ComposerView.tsx) never sends the field it
 * collects, so it is not a real mount site for this capability.
 */
export const AGENT_CHAINS_SURFACE = registerFeatureSurface({
  key: 'agent_chains',
  tab: 'tasks',
  where: 'Tasks › Edit task › Chain after',
  anchorId: 'agent-chains',
});

type StatusFilter = 'all' | 'active' | 'paused';
type SortKey = 'name' | 'recent';
type Section = 'tasks' | 'pairs' | 'sentinels' | 'repo';

/** Section key → the anchor its feature surface registered, for the always-rendered switch buttons. */
const SECTION_ANCHOR: Partial<Record<Section, string>> = {
  pairs: PLAN_EXECUTE_SURFACE.anchorId,
  sentinels: SENTINEL_SURFACE.anchorId,
  repo: REPO_JOBS_SURFACE.anchorId,
};

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

/**
 * T4-5: the list is meant to read like a schedule — grouped by shape, not one
 * flat pile. The proof of recurrence is "has run AND still has a next fire":
 * a one-off's `nextFire` goes null the moment its one occurrence runs (daemon
 * scheduler.ts NULLs it for `kind === 'once'` right after firing), so a task
 * that has run at least once and STILL carries a non-null `nextFire` cannot
 * be a one-off — only a recurring schedule reaches that combination. A
 * schedule that has never fired is indistinguishable from a one-off until its
 * first run lands, so a brand-new recurring task is filed as One-off for
 * exactly one run and reclassifies itself afterward. That is an honest,
 * self-correcting reading of the two fields the daemon actually hands back
 * (`nextFire` nullness, run history) — there is no `schedule.kind` on
 * TaskViewT to read directly (daemon api.ts `view()` strips it), and this
 * view may not add one.
 *
 * `nextFire` is read from the `schedules` row regardless of `enabled`
 * (daemon api.ts: `GET /tasks` and `PATCH /tasks/:id` both do
 * `tasks.scheduleFor(id).next_fire`), and a plain `{enabled}` PATCH never
 * touches that row (repo.ts `patch()` only writes `next_fire` inside
 * `if (input.schedule)`) — so pausing a recurring task does NOT null its
 * `nextFire`. That is what keeps a paused-but-recurring task out of
 * Finished: it still has a future fire on file, it just will not be acted on
 * while paused.
 */
export type TaskGroup = 'recurring' | 'oneOff' | 'finished';

/**
 * `hasRun` is "has at least one TERMINAL run", not "has any run row at all" —
 * a task whose only run is still in flight has not produced an outcome yet,
 * so it reads as not-yet-run rather than as finished.
 */
export function taskBucket(task: Pick<TaskViewT, 'nextFire'>, hasRun: boolean): TaskGroup {
  if (!hasRun) return 'oneOff';
  return task.nextFire != null ? 'recurring' : 'finished';
}

/** Run states that have not produced a result yet — the opposite of `chipFor`'s 'running'/'needs-you' buckets. */
export function isTerminalRun(state: string): boolean {
  const c = chipFor(state);
  return c !== 'running' && c !== 'needs-you';
}

/**
 * The two most recent TERMINAL runs for a task, cost compared. `runs` must
 * already be newest-first (GET /runs is: repo.ts orders `DESC`) — this does
 * not re-sort. Fewer than two terminal runs means there is nothing to trend
 * against yet, so the element is omitted rather than drawn with one point.
 */
export function costTrendFor(
  runsNewestFirst: Array<Pick<RunRowT, 'cost_usd'>>,
): { direction: 'up' | 'down' | 'flat'; deltaUsd: number } | null {
  if (runsNewestFirst.length < 2) return null;
  const [latest, prev] = runsNewestFirst;
  const deltaUsd = latest.cost_usd - prev.cost_usd;
  return { direction: deltaUsd > 0 ? 'up' : deltaUsd < 0 ? 'down' : 'flat', deltaUsd: Math.abs(deltaUsd) };
}

/** A repo path's last segment — the readable part; the full path still lives in `title` for hover. */
export function repoBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Next fire in human words instead of a raw locale timestamp (T4-5). Mirrors
 * the shape of `App.tsx`'s `formatNextFire` (today = bare time, this week =
 * weekday, further = a date) but is a separate function, not an import of
 * it: App.tsx imports TasksView, so TasksView importing back from App.tsx
 * would be a circular import — and pulling the shared logic out into its own
 * module would mean editing App.tsx, which is outside this task's touch set.
 * `now` defaults to the real clock and takes an override so tests can pin a
 * moment, the same shape `formatNextFire` uses.
 */
export function humanNextFire(ts: number, now: Date = new Date()): string {
  const time = new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date(ts)) - midnight(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${new Date(ts).toLocaleDateString(undefined, { weekday: 'long' })} ${time}`;
  const sameYear = new Date(ts).getFullYear() === now.getFullYear();
  return `${new Date(ts).toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`;
}

/**
 * T4-8: download a task as a shareable `clockwork.template.v1` file. Hits the
 * daemon route directly (bearer-token fetch → blob → object URL), the same
 * reason ProposedEvents' `downloadIcs` does: the shared `api.ts` request
 * helper (`../api`) parses every response as JSON-then-typed and has no
 * generic "give me the raw bytes" escape hatch, and `api.ts` is out of this
 * task's touch scope regardless. Throws (rather than swallowing, unlike
 * `downloadIcs`) so the caller's `act()` can surface a real failure instead
 * of a silent no-op — an export the user cannot get is not a minor miss.
 */
async function downloadTaskTemplate(taskId: string): Promise<void> {
  const res = await fetch(`/tasks/${taskId}/export-template`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error(typeof body.error === 'string' ? body.error : `export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Same filename shape as the daemon's own `templateExportFilenameFor`
  // (templates.ts) — duplicated here rather than read off the response's
  // Content-Disposition header, the same call ProofOfWorkExport.tsx already
  // made for the proof-of-work export's filename.
  a.download = `clockwork-template-${taskId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function TasksView({ version }: { version: number }): JSX.Element {
  const tasks = useAsync(() => api.tasks(), [version]);
  const queue = useAsync(() => api.queue(), [version]);
  // F1: fetched HERE, not inside the pairs section — the task rows need the
  // same answer to decide whether Run now / Enable can succeed at all.
  const pairs = useAsync(() => api.planExecuteList(), [version]);
  // T4-5: last outcome, cost trend and the Recurring/One-off/Finished split
  // all read run HISTORY, which TaskViewT does not carry. `api.runs` already
  // exists and is already called this way, unfiltered and batched, by
  // InboxView (`limit: 200`) and TimesheetsPanel (`limit: 1000`) — one fetch
  // grouped by task_id client-side, not one request per row. 1000 is the
  // daemon's own cap (repo.ts RunRepo.list: `Math.min(filter.limit ?? 200,
  // 1000)`).
  const runs = useAsync(() => api.runs({ limit: 1000 }), [version]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskViewT | null>(null);
  const [deleting, setDeleting] = useState<TaskViewT | null>(null);
  /** T4-8: the "Import template" dialog — a page-level action, not a per-row one. */
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /** Finished starts collapsed (T4-5) — it is the "already happened" pile, not today's work. */
  const [finishedOpen, setFinishedOpen] = useState(false);
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

  /**
   * task_id → its TERMINAL runs, newest first. GET /runs is already ordered
   * `DESC` (daemon repo.ts), so any per-task subsequence of it stays
   * newest-first without a re-sort. A run still in flight proves nothing
   * about the last OUTCOME, so it is left out here on purpose.
   */
  const runsByTask = useMemo(() => {
    const m = new Map<string, RunRowT[]>();
    for (const r of runs.data ?? []) {
      if (!isTerminalRun(r.state)) continue;
      const list = m.get(r.task_id);
      if (list) list.push(r);
      else m.set(r.task_id, [r]);
    }
    return m;
  }, [runs.data]);

  /** Recurring, then One-off, then Finished (T4-5) — see `taskBucket` for the rule. */
  const grouped = useMemo(() => {
    const recurring: TaskViewT[] = [];
    const oneOff: TaskViewT[] = [];
    const finished: TaskViewT[] = [];
    for (const t of filtered) {
      const bucket = taskBucket(t, (runsByTask.get(t.id)?.length ?? 0) > 0);
      (bucket === 'recurring' ? recurring : bucket === 'oneOff' ? oneOff : finished).push(t);
    }
    return { recurring, oneOff, finished };
  }, [filtered, runsByTask]);

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
      // A run just landed or changed — the outcome chip / cost trend it feeds
      // would otherwise stay stale until the next unrelated reload.
      runs.reload();
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
  //
  // `runs` is deliberately NOT in this gate (S-review/advisor): it only
  // feeds the outcome chip, the cost trend and the Recurring/One-off split,
  // none of which the row NEEDS to draw safely — unlike the pair lookup,
  // nothing here decides whether a button would 409. A slow or failed
  // history fetch degrades those extras, it does not withhold the row.
  const rowsReady = !tasks.loading && !tasks.error && !pairs.loading;

  const renderRow = (t: TaskViewT): JSX.Element => {
    const executePair = byExecuteTask.get(t.id) ?? null;
    const planPair = byPlanTask.get(t.id) ?? null;
    const taskRuns = runsByTask.get(t.id) ?? [];
    return (
      <TaskRow
        key={t.id}
        task={t}
        role={executePair ? 'execute' : planPair ? 'plan' : 'plain'}
        pair={executePair ?? planPair}
        lastOutcome={taskRuns[0] ?? null}
        costTrend={costTrendFor(taskRuns)}
        onRunNow={() => void act(() => api.runNow(t.id), `Run queued for “${t.name}” — watch the calendar or inbox.`)}
        onToggle={() => void act(() => api.patchTask(t.id, { enabled: !t.enabled, version: t.version }))}
        onEdit={() => setEditing(t)}
        onDelete={() => setDeleting(t)}
        onExport={() => void act(() => downloadTaskTemplate(t.id))}
        onReviewPlan={() => {
          if (executePair?.planRunId) openRunInInbox(executePair.planRunId);
          else openInbox();
        }}
        onViewPair={() => setSection('pairs')}
      />
    );
  };

  // "Show N more" paginates Recurring then One-off, in that order — the two
  // groups a reader sees without opening anything. Finished stays outside
  // this budget entirely: it is collapsed by default, and once opened it
  // shows in full rather than adding a second, nested "show more".
  const recurringVisible = grouped.recurring.slice(0, visibleCount);
  const oneOffVisible = grouped.oneOff.slice(0, Math.max(0, visibleCount - grouped.recurring.length));
  const activeTotal = grouped.recurring.length + grouped.oneOff.length;

  return (
    <div className="tasks-page">
      <div className="seg" role="tablist" aria-label="Tasks sections" style={{ marginBottom: 10 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            id={SECTION_ANCHOR[s.key]}
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
            <button
              className="btn small"
              onClick={() => { tasks.reload(); queue.reload(); pairs.reload(); runs.reload(); }}
              aria-label="Refresh tasks"
            >
              ⟳
            </button>
            {/* T4-8: a page-level action (any file, not one row's) — round-trips
                through the same `/templates/preview` + `/templates/import`
                routes a row's own "Export template" produces a file for. */}
            <button className="btn small" onClick={() => setImporting(true)} data-testid="import-template-open">
              Import template
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
          {/* Quiet, not `role="alert"` (S-review/advisor): this is a soft
              degradation — rows still render, they just carry no outcome
              chip, no cost trend, and read as One-off until history loads. */}
          {runs.error && (
            <div className="hint" data-testid="runs-unknown">
              Couldn’t load run history: {runs.error}. Last-outcome, cost trend and the Recurring/One-off split are
              unavailable until this loads. <button className="btn small" onClick={runs.reload}>Retry</button>
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

          {/* ---- list: Recurring, then One-off, then Finished (collapsed) — T4-5 ---- */}
          {rowsReady && grouped.recurring.length > 0 && (
            <div style={{ marginBottom: 20 }} data-testid="tasks-group-recurring">
              <h3 className="section-title">Recurring</h3>
              <div className="tasklist">{recurringVisible.map(renderRow)}</div>
            </div>
          )}
          {rowsReady && grouped.oneOff.length > 0 && (
            <div style={{ marginBottom: 20 }} data-testid="tasks-group-oneoff">
              <h3 className="section-title">One-off</h3>
              <div className="tasklist">{oneOffVisible.map(renderRow)}</div>
            </div>
          )}
          {rowsReady && activeTotal > 0 && visibleCount < activeTotal && (
            <button className="btn small" style={{ marginTop: 12 }} onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} data-testid="task-more">
              Show {Math.min(PAGE_SIZE, activeTotal - visibleCount)} more ({activeTotal - visibleCount} hidden)
            </button>
          )}
          {rowsReady && grouped.finished.length > 0 && (
            <div style={{ marginTop: 20 }} data-testid="tasks-group-finished">
              <button
                type="button"
                className="section-title disclosure"
                aria-expanded={finishedOpen}
                data-testid="tasks-finished-toggle"
                onClick={() => setFinishedOpen((o) => !o)}
              >
                {finishedOpen ? '▾' : '▸'} Finished ({grouped.finished.length})
              </button>
              {finishedOpen && <div className="tasklist" style={{ marginTop: 8 }}>{grouped.finished.map(renderRow)}</div>}
            </div>
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

      {importing && (
        <ImportTemplateDialog
          onClose={() => setImporting(false)}
          onImported={(msg) => {
            setImporting(false);
            setNotice(msg);
            setTimeout(() => setNotice(null), 4000);
            tasks.reload();
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
  lastOutcome,
  costTrend,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
  onExport,
  onReviewPlan,
  onViewPair,
}: {
  task: TaskViewT;
  role: PairRole;
  pair: PlanExecutePairT | null;
  /** Most recent TERMINAL run for this task, or null when there is none (or history has not loaded). */
  lastOutcome: RunRowT | null;
  /** Cost vs the terminal run before it, or null below two terminal runs. */
  costTrend: { direction: 'up' | 'down' | 'flat'; deltaUsd: number } | null;
  onRunNow: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** T4-8: download this task as a shareable `clockwork.template.v1` file. */
  onExport: () => void;
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
        {/* T1-14: the chips used to sit inline INSIDE the <strong>, so a card
            narrower than the title wrapped mid-phrase — "Nightly security
            scan last: Completed" broke across three lines. Name on its own
            row, chips on a second row that wraps as a group. Caught by
            looking at a rendered screenshot; jsdom cannot see it. */}
        <strong className="task-row-title">
          <span className="task-row-name">{task.name}</span>
          <span className="task-row-chips">
          {lastOutcome && (
            <span className={`chip ${chipFor(lastOutcome.state)}`} data-testid="last-outcome">
              last: {stateLabel(lastOutcome.state)}
            </span>
          )}{' '}
          {gate ? (
            <span className={`chip ${gate.chipClass}`}>{gate.chipLabel}</span>
          ) : (
            !task.enabled && <span className="chip failed">paused</span>
          )}
          {role === 'plan' && <span className="chip">plan half</span>}
          </span>
        </strong>
        <div className="hint" style={{ margin: 0 }}>
          next {task.enabled ? (task.nextFire ? humanNextFire(task.nextFire) : '—') : '—'}
          {' · '}${task.budget.maxUsd} · {task.permissionMode}
          {' · '}
          {task.repoPath ? (
            <span title={task.repoPath}>{repoBasename(task.repoPath)}</span>
          ) : (
            'no repo — scratch task'
          )}
          {/* "flat" (delta 0) is not a trend worth a line — only up/down draw. */}
          {costTrend && costTrend.direction !== 'flat' && (
            <span data-testid="cost-trend">
              {' · '}cost {costTrend.direction === 'up' ? '↑' : '↓'} ${costTrend.deltaUsd.toFixed(2)} vs last run
            </span>
          )}
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
      {/* T4-5: Delete demoted into an overflow menu — Run now stays the only
          primary action and Delete no longer sits at its visual weight. The
          confirm step is unchanged: `onDelete` still only sets TasksView's
          `deleting` state, which still opens the same `ConfirmDialog`
          (below, TasksView.tsx) — moving the trigger does not touch it. */}
      <TaskRowMenu taskName={task.name} onDelete={onDelete} onExport={onExport} />
    </div>
  );
}

/**
 * The row's overflow menu. T4-5 put Delete here for demotion (Edit/Pause stay
 * top-level buttons); T4-8 added Export template beside it — sharing a job is
 * an occasional action like Delete, not an everyday one like Run now, so it
 * earns a menu slot rather than a fifth top-level button.
 *
 * Hand-rolled rather than the app's Radix `Popover` (already used by
 * ModelSelector/ui/popover.tsx): this test suite avoids opening Radix's
 * popper-based pickers in jsdom on purpose — "Radix Select is never opened
 * here on purpose — it needs pointer-capture APIs jsdom does not implement"
 * (tasks-workforce.test.tsx, file header). A Radix menu here would be UI this
 * suite structurally could not exercise; a plain toggle + outside-click needs
 * no such API and is fully testable with a real DOM click.
 */
function TaskRowMenu({
  taskName,
  onDelete,
  onExport,
}: {
  taskName: string;
  onDelete: () => void;
  onExport: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div className="row-menu" ref={ref}>
      <button
        type="button"
        className="btn small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${taskName}`}
        data-testid="row-menu-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        ⋮
      </button>
      {open && (
        <div className="row-menu-panel" role="menu" data-testid="row-menu-panel">
          <button
            type="button"
            role="menuitem"
            className="btn small"
            aria-label={`Export ${taskName} as a template`}
            data-testid="row-menu-export"
            onClick={() => {
              setOpen(false);
              onExport();
            }}
          >
            Export template
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn danger small"
            aria-label={`Delete ${taskName}`}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
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

        <label className="f" id={AGENT_CHAINS_SURFACE.anchorId}>Chain after (run when that task finishes)</label>
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

interface TemplatePreviewFlag {
  level: 'red' | 'yellow' | 'info';
  text: string;
}

/**
 * T4-8: import ANY `clockwork.template.v1` file — a stranger's, or one just
 * downloaded from this same screen's own row "Export template" — through the
 * EXISTING `POST /templates/preview` then `POST /templates/import` routes
 * (api.ts). There is no special-cased "self-import" shortcut: dropping a
 * file this screen just exported and dropping a stranger's file here hit the
 * exact same code path, so the security preview and the arrives-disabled
 * rule apply identically to both — that IS the round trip T4-8 asks for.
 *
 * Raw `fetch` + bearer header, not `../api`'s wrapped client, for the same
 * touch-scope reason `downloadTaskTemplate` above is:
 * `packages/ui/src/api.ts` is out of this task's edit set, and its `req<T>`
 * helper is not exported for a caller outside that file to reuse anyway.
 */
function ImportTemplateDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (msg: string) => void;
}): JSX.Element {
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null);
  const [flags, setFlags] = useState<TemplatePreviewFlag[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  interface TemplateRouteResponse {
    error?: string;
    preview?: { flags?: TemplatePreviewFlag[] };
  }

  const post = async (path: string, body: unknown): Promise<{ ok: boolean; body: TemplateRouteResponse }> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}) as TemplateRouteResponse);
    return { ok: res.ok, body: json as TemplateRouteResponse };
  };

  /** Selecting a file previews it immediately — nothing is imported until "Import" is clicked. */
  const onFile = async (file: File): Promise<void> => {
    setErr(null);
    setFlags(null);
    setParsed(null);
    setFileName(file.name);
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setErr(`“${file.name}” is not valid JSON.`);
      return;
    }
    try {
      const { ok, body } = await post('/templates/preview', json);
      if (!ok) {
        setErr(typeof body.error === 'string' ? body.error : 'preview failed');
        return;
      }
      setParsed(json as Record<string, unknown>);
      setFlags(body.preview?.flags ?? []);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const doImport = async (): Promise<void> => {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    try {
      const { ok, body } = await post('/templates/import', parsed);
      if (!ok) {
        setErr(typeof body.error === 'string' ? body.error : 'import failed');
        return;
      }
      const name = typeof parsed.name === 'string' ? parsed.name : 'template';
      onImported(`Imported “${name}” — disabled, review the security preview before enabling.`);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // S-74 client-side courtesy only — the real refusal is server-side: a red
  // flag still 422s at `/templates/import` (see `securityPreview`,
  // templates.ts) even if this check were bypassed entirely.
  const hasRed = flags?.some((f) => f.level === 'red') ?? false;

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Import template</h3>
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Any clockwork.template.v1 file — your own export, or one someone sent you. It goes through the same
          security preview as every import, and arrives disabled either way.
        </p>
        <label className="f">Template file (.json)</label>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Template file"
          data-testid="import-template-file"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onFile(f);
          }}
        />
        {fileName && <div className="hint">{fileName}</div>}
        {flags && (
          <ul data-testid="import-template-flags" style={{ margin: '8px 0', paddingLeft: 18 }}>
            {flags.map((f, i) => (
              <li key={i} data-testid={`import-template-flag-${f.level}`}>
                <strong>{f.level.toUpperCase()}</strong> — {f.text}
              </li>
            ))}
          </ul>
        )}
        {err && (
          <div className="error-banner" role="alert">
            {err}
          </div>
        )}
        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!parsed || hasRed || busy}
            data-testid="import-template-confirm"
            onClick={() => void doImport()}
          >
            {busy ? 'Importing…' : 'Import (arrives disabled)'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { ConfirmDialog };
