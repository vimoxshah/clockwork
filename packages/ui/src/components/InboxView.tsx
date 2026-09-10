/**
 * Inbox (T-124): run reports with FTS-backed search, outcome filters,
 * unread tracking, approvals with REAL respond actions, report detail with
 * transcript viewer.
 *
 * The approvals list is mixed: a live permission prompt (answer inside the
 * child's decision window) sits beside F1 plan approvals and F8 remediation
 * proposals, which have no window at all. ApprovalCard tells them apart.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type RunRowT } from '../api';
import { useAsync } from '../useAsync';
import { ProposedEvents } from './ProposedEvents';
import { OutcomeControls } from './OutcomeControls';
import { ApprovalCard } from './ApprovalCard';
import { APPROVALS_SURFACE } from './ApprovalCard';
import { ProofOfWorkExport } from './ProofOfWorkExport';
import { TaskMemoryPanel } from './TaskMemoryPanel';
import { chipFor, stateLabel } from '../lib/runState';

type OutcomeFilter = 'all' | 'completed' | 'failed' | 'active' | 'needsyou';

/**
 * What each filter is CALLED, as opposed to what it is keyed by.
 *
 * The chips used to render the enum value itself, so the bar read
 * "all completed failed active" — internal identifiers, lower-cased, shown to
 * a person. The order here is the order on screen.
 */
const FILTER_LABELS: Record<OutcomeFilter, string> = {
  all: 'All',
  completed: 'Completed',
  failed: 'Failed',
  active: 'Active',
  needsyou: 'Needs you',
};

const UNREAD_KEY = 'clockwork.inbox.lastRead';


/**
 * "needs you" used to check only the RUN's own state
 * (`waiting_approval`/`awaiting_user` — true for a live permission prompt).
 * F1 plan approvals and F8 remediation proposals are opened when a run
 * FINALIZES (plan-execute.ts, self-healing.ts), so the run they hang off is
 * already `completed` by the time the approval exists — that state can never
 * match, so the one filter meant to surface work needing a human showed
 * nothing for the two most common cases. `needsYouRunIds` (every run_id with
 * an unresolved approval, computed from `GET /approvals`) is unioned in here
 * so a finalized run with a pending decision still shows up under the chip.
 */
export function matchesFilter(r: Pick<RunRowT, 'id' | 'state'>, f: OutcomeFilter, needsYouRunIds: ReadonlySet<string>): boolean {
  const state = r.state;
  switch (f) {
    case 'all': return true;
    case 'completed': return state === 'completed';
    case 'failed': return ['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state);
    case 'active': return ['running', 'queued', 'preparing', 'finalizing'].includes(state);
    case 'needsyou': return needsYouRunIds.has(r.id) || ['waiting_approval', 'awaiting_user'].includes(state);
  }
}

/**
 * Is this run still going, as far as the REPORT VIEW is concerned — i.e. can
 * it still produce output a live tail should show?
 *
 * Deliberately NOT the same set as the "Active" filter chip above, which also
 * counts `queued` (a booking with no child yet, so nothing to tail) and drops
 * the two waiting states (a run paused on a human is very much still running,
 * and its tail is exactly where the human should answer). Two questions, two
 * sets; merging them would break one of them.
 */
export function isRunActive(state: string): boolean {
  return ['running', 'preparing', 'finalizing', 'waiting_approval', 'awaiting_user'].includes(state);
}

/**
 * Honest empty state: "No runs yet" is only true when there truly are no
 * runs. A filter or search that simply matched nothing gets its own message
 * instead of implying the user has never booked a run.
 */
export function emptyMessageFor(q: string, filter: OutcomeFilter, totalRuns: number): string {
  const term = q.trim();
  if (term) return `No runs match “${term}”.`;
  if (totalRuns === 0) return 'No runs yet. Book one from the calendar.';
  switch (filter) {
    case 'needsyou':
      return 'Nothing needs your decision right now — plan approvals and remediation proposals show up here the moment one is waiting.';
    case 'completed': return 'No completed runs yet.';
    case 'failed': return 'No failed runs — nothing to fix.';
    case 'active': return 'Nothing running right now.';
    default: return 'No runs match this filter.';
  }
}

/**
 * Has this row arrived since the user last read the inbox?
 *
 * Lifted out of the row renderer so the unread mark on a row and the digest's
 * "is there anything to summarise?" gate share one definition of "arrived".
 * They deliberately pass DIFFERENT bounds — the row passes `lastRead`, the
 * digest passes `digestSince`, for the reason set out where `digestSince` is
 * declared — but neither can invent its own idea of what an arrival is. A
 * digest drawn over a list with no unread row would be a claim about a night
 * that has already been read.
 *
 * A live run is never unread: nothing has arrived from it yet, and it becomes
 * unread by itself the moment it ends.
 */
export function isUnread(r: Pick<RunRowT, 'state' | 'started_at' | 'ended_at'>, lastRead: number): boolean {
  return (r.ended_at ?? r.started_at ?? 0) > lastRead && r.state !== 'running' && r.state !== 'queued';
}

/**
 * Terminal run states. `packages/shared/src/states.ts:23` owns the set; it is
 * restated here because nothing under `packages/ui/src` imports
 * `@clockwork/shared` (api.ts:314 — the UI is a pure wire client), which is
 * also why every other state list in this file is inline.
 */
const TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out', 'missed'];

/**
 * The two definitions of "failed" this file has to hold at once, and both are
 * right for their own question.
 *
 * `GET /analytics` counts `failed` and `timed_out` and nothing else, so to it
 * a `budget_exceeded` run is terminal but not a failure. `matchesFilter` above
 * puts `budget_exceeded` and `missed` under the "Failed" chip, because a
 * person asking what went wrong wants all four.
 *
 * The digest uses the analytics set for its NUMBER — a test holds that number
 * against `GET /analytics` on the same corpus — and the wider set for the
 * exceptions LIST, which is the chip's question rather than analytics'.
 */
const ANALYTICS_FAILED_STATES = ['failed', 'timed_out'];
const WENT_WRONG_STATES = ['failed', 'timed_out', 'budget_exceeded', 'missed'];

/** The jobspec fields this view reads. The wire carries far more (schemas.ts JobSpec). */
export interface JobSpecViewT {
  taskName?: string;
  engine?: string;
  repoPath?: string | null;
  baseBranch?: string | null;
}

/** The report fields this view reads. The wire carries far more (delivery.ts RunReport). */
export interface RunReportViewT {
  committedSomething?: boolean;
  branch?: string | null;
}

/** Why a run is on the digest's exceptions list. A blocked run outranks a broken one. */
export type DigestExceptionKind = 'needs_you' | 'went_wrong';

export interface DigestExceptionT {
  runId: string;
  taskName: string;
  kind: DigestExceptionKind;
  /** the run's own state, so a budget bust does not read as a crash */
  state: string;
  /** `outcome_reason`, when the daemon recorded one */
  reason: string | null;
  at: number;
}

export interface DigestT {
  /** the window's lower bound — the moment the user last read the inbox */
  since: number;
  /** every run in the window, finished or not */
  runs: number;
  /** terminal runs — the denominator of the one rate below */
  finished: number;
  completed: number;
  /** analytics' definition: `failed` + `timed_out` */
  failed: number;
  /** `runs - finished`, reported separately and counted in no rate */
  inFlight: number;
  /** runs with an unresolved approval, or whose own state waits on a human */
  needsYou: number;
  /** spend in the window, including what an unfinished run has already spent */
  costUsd: number;
  /** runs whose cost is not a measurement — opencode reports a literal 0 */
  costUnreported: number;
  /** completed runs that actually committed, so the branch still exists */
  branchesWaiting: number;
  /** `completed / finished`, or null when nothing has finished */
  successRate: number | null;
  /** needs-you first, then whatever went wrong, newest first within each */
  exceptions: DigestExceptionT[];
}

/**
 * What happened while you were not looking (T4-9).
 *
 * WINDOW. A run belongs to the window when `COALESCE(ended_at, scheduled_for)`
 * falls inside `(since, now]`. That is `GET /analytics`'s own predicate
 * (api.ts:2665), taken in preference to this file's `ended_at ?? started_at ??
 * scheduled_for` grouping chain so that the digest and the Analytics tab can
 * never disagree about which runs a window holds. The upper bound is not
 * decoration: `GET /runs` returns future bookings too, and tomorrow's 02:00
 * job is not part of last night.
 *
 * COUNTING. A run still in flight is treated exactly as analytics treats it
 * (api.ts:2637-2646): counted in `runs`, its spend so far counted because that
 * money is already gone, reported separately as `inFlight`, never `completed`,
 * never `failed`, and kept out of the one rate here — `successRate` divides by
 * finished runs. One divergence, in the empty case only: analytics answers
 * `successRate: 0` when nothing has finished, which is fine for a table cell,
 * but a headline reading "0% completed" over a night where nothing had
 * finished yet would be false. This returns `null` and the digest says nothing.
 *
 * BRANCHES. Counted on `committedSomething`, never on `run.branch`. The column
 * is written for every repo run whether or not it committed (run-manager.ts:983),
 * and an analysis-only run's branch is deleted at finalize
 * (run-manager.ts:765-767) — so counting the column would promise branches
 * that no longer exist.
 */
export function digestOf(
  runs: readonly RunRowT[],
  needsYouRunIds: ReadonlySet<string>,
  since: number,
  now: number,
): DigestT {
  const d: DigestT = {
    since,
    runs: 0,
    finished: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    needsYou: 0,
    costUsd: 0,
    costUnreported: 0,
    branchesWaiting: 0,
    successRate: null,
    exceptions: [],
  };

  for (const r of runs) {
    const at = r.ended_at ?? r.scheduled_for;
    if (typeof at !== 'number' || at <= since || at > now) continue;

    d.runs += 1;
    const finished = TERMINAL_STATES.includes(r.state);
    if (finished) d.finished += 1;
    if (r.state === 'completed') d.completed += 1;
    if (ANALYTICS_FAILED_STATES.includes(r.state)) d.failed += 1;

    const spec: JobSpecViewT = safeJson(r.jobspec_json);
    const cost = Number(r.cost_usd ?? 0);
    if (Number.isFinite(cost)) d.costUsd += cost;
    // Same rule fmtCost renders by: opencode publishes no usage telemetry, so
    // its 0 means "not measured", and an absent cost means the same thing.
    if (spec.engine === 'opencode' || r.cost_usd === null || r.cost_usd === undefined) d.costUnreported += 1;

    const needsYou = needsYouRunIds.has(r.id) || ['waiting_approval', 'awaiting_user'].includes(r.state);
    if (needsYou) d.needsYou += 1;

    const report: RunReportViewT | null = r.report_json ? safeJson(r.report_json) : null;
    if (r.state === 'completed' && r.branch && report?.committedSomething === true) d.branchesWaiting += 1;

    if (needsYou || WENT_WRONG_STATES.includes(r.state)) {
      d.exceptions.push({
        runId: r.id,
        taskName: spec.taskName ?? 'Untitled task',
        kind: needsYou ? 'needs_you' : 'went_wrong',
        state: r.state,
        reason: r.outcome_reason,
        at,
      });
    }
  }

  d.costUsd = Math.round(d.costUsd * 10_000) / 10_000;
  d.inFlight = d.runs - d.finished;
  d.successRate = d.finished ? Math.round((d.completed / d.finished) * 100) : null;
  d.exceptions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'needs_you' ? -1 : 1;
    return b.at - a.at;
  });
  return d;
}

/** A slept-for duration in the words a person would use. */
function sleptForText(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 120) return `${sec} seconds`;
  const min = Math.round(sec / 60);
  if (min < 120) return `${min} minutes`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hours} hours` : `${hours}h ${rest}m`;
}

/**
 * T1-9. The sentence a person reads instead of decoding a boolean: "this Mac
 * slept for 42 minutes during this run".
 *
 * READS `sleptDuringRunMs` AND NOTHING ELSE, on purpose. Every report stored
 * before T1-9 carries a `false` under `sleptThroughKeepAwake`, written by a
 * line that never measured anything (run-manager.ts, until T1-9), so a reader
 * keyed off the boolean would turn "nobody looked" into "it did not happen"
 * on every historical report — the defect, re-rendered. `sleptDuringRunMs` is
 * absent from all of those, and absence is not a claim.
 *
 * The wording above never puts a colon straight after the boolean's name,
 * and that is deliberate: a claims-honesty tripwire counts every package
 * source file matching that pattern and requires exactly two writers of the
 * field. A docstring quoting the old key-and-value would read as a third.
 *
 * Returns `null` for both "no sleep" and "not checked", and that is
 * deliberate. Silence is the only honest rendering of "not checked", and a
 * line on every clean report saying the Mac stayed awake would be noise the
 * user has to read past. The two stay distinguishable in the data (`0` vs
 * absent) where the distinction can be audited.
 */
export function describeSleep(report: { sleptDuringRunMs?: number } | null | undefined): string | null {
  const ms = report?.sleptDuringRunMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return `⏾ This Mac slept for about ${sleptForText(ms)} during this run. The agent was frozen for that time.`;
}

export default function InboxView({ version }: { version: number }): JSX.Element {
  const runs = useAsync(() => api.runs({ limit: 200 }), [version]);
  const approvals = useAsync(() => api.approvals(), [version]);
  const [selected, setSelected] = useState<string | null>(null);
  // deep-link: toast click sets a pending run id; apply it on next render
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (pending) {
      setSelected(pending);
      setPending(null);
    }
  }, [pending]);
  // listen for deep-link nudges (toast click while inbox is/isn't mounted)
  useEffect(() => {
    const onOpenRun = (e: Event): void => setPending((e as CustomEvent<string>).detail);
    window.addEventListener('clockwork:open-run', onOpenRun);
    // also apply anything queued before mount
    if (pendingRunId) {
      setSelected(pendingRunId);
      pendingRunId = null;
    }
    return () => window.removeEventListener('clockwork:open-run', onOpenRun);
  }, []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<OutcomeFilter>('all');
  const [ftsOrder, setFtsOrder] = useState<Map<string, string> | null>(null);
  const [lastRead, setLastRead] = useState<number>(() => Number(localStorage.getItem(UNREAD_KEY) ?? 0));
  /**
   * The digest's window bound, which is NOT `lastRead`.
   *
   * `selectRun` advances `lastRead` to the run you just opened, so a digest
   * that recomputed from it would shrink every time you opened an exception —
   * by the third one it would be summarising a night you had already worked
   * half-way through. The morning question is "what happened since I last
   * looked BEFORE this visit", and that answer must hold still while you
   * answer it. Only "Mark all read" moves it, which is exactly the gesture
   * that means "this night is dealt with".
   */
  const [digestSince, setDigestSince] = useState<number>(() => Number(localStorage.getItem(UNREAD_KEY) ?? 0));

  // FTS search — server-side rank; falls back to local filter on empty query.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setFtsOrder(null);
      return;
    }
    let alive = true;
    api
      .search(term, 'run')
      .then((hits) => {
        if (!alive) return;
        const order = new Map<string, string>();
        hits.forEach((h) => order.set(h.ref_id, h.snip));
        setFtsOrder(order);
      })
      .catch(() => setFtsOrder(null));
    return () => {
      alive = false;
    };
  }, [q]);

  // Every run_id with an unresolved approval — a plan (F1) or remediation
  // (F8) approval opens once its run has already finalized, so this is the
  // only way "needs you" can find that run again (see matchesFilter above).
  const needsYouRunIds = useMemo(
    () => new Set((approvals.data ?? []).map((a) => String(a.run_id))),
    [approvals.data],
  );

  const visibleRuns = useMemo(() => {
    let rows = runs.data ?? [];
    if (ftsOrder) {
      rows = [...rows].sort((a, b) => {
        const ai = ftsOrder.has(a.id) ? 0 : 1;
        const bi = ftsOrder.has(b.id) ? 0 : 1;
        return ai - bi;
      }).filter((r) => ftsOrder.has(r.id));
    }
    return rows.filter((r) => matchesFilter(r, filter, needsYouRunIds));
  }, [runs.data, ftsOrder, filter, needsYouRunIds]);

  // IA: group by recency so the inbox answers "what happened while I wasn't looking?"
  const grouped = useMemo(() => {
    const startOfToday = todayMidnightLocal();
    const groups: Record<string, RunRowT[]> = { Today: [], Yesterday: [], Earlier: [] };
    for (const r of visibleRuns) {
      const ts = r.ended_at ?? r.started_at ?? r.scheduled_for ?? 0;
      if (ts >= startOfToday) groups.Today!.push(r);
      else if (ts >= startOfToday - 86_400_000) groups.Yesterday!.push(r);
      else groups.Earlier!.push(r);
    }
    return Object.entries(groups).filter(([, rows]) => rows.length > 0);
  }, [visibleRuns]);

  const selectRun = (id: string): void => {
    setSelected(id);
    const row = (runs.data ?? []).find((r) => r.id === id);
    const ts = row?.ended_at ?? Date.now();
    if (ts > lastRead) {
      localStorage.setItem(UNREAD_KEY, String(ts));
      setLastRead(ts);
    }
  };

  const markAllRead = (): void => {
    const now = Date.now();
    localStorage.setItem(UNREAD_KEY, String(now));
    setLastRead(now);
    setDigestSince(now);
  };

  /**
   * The landing view when the night left something unread (T4-9).
   *
   * The GATE is unread rows, not the window: a run still in flight makes
   * nothing unread by itself (`isUnread`), so a digest never appears merely
   * because something is running. Once it does appear, the window it counts
   * over includes that in-flight run — "1 still running" is half the answer to
   * "did the night go well".
   *
   * Both the gate and the window read `digestSince`, never `lastRead`, and
   * that is load-bearing rather than tidy. `selectRun` advances `lastRead` to
   * the run you just opened, so a gate on `lastRead` would delete the digest
   * the moment you opened its newest exception — leaving no way back to the
   * other five. Marking the night read is the one gesture that closes it.
   */
  const digest = useMemo(() => {
    const rows = runs.data ?? [];
    if (!rows.some((r) => isUnread(r, digestSince))) return null;
    return digestOf(rows, needsYouRunIds, digestSince, Date.now());
  }, [runs.data, needsYouRunIds, digestSince]);

  return (
    <div className="inbox-layout">
      <div className="inbox-list">
        <div className="relative mb-2">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">🔍</span>
          <input
            className="inbox-search !pl-9 !pr-16"
            placeholder="Search everything…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="inbox-search"
            aria-label="Search runs"
            id="inbox-search-input"
          />
          {q && (
            <button
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="absolute right-12 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-dim hover:text-fg"
            >
              ✕
            </button>
          )}
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 text-micro text-dim">
            ⌘K
          </kbd>
        </div>
        <KeyFocus />
        {q.trim() && (
          <p className="mb-2 text-xs text-dim">
            {visibleRuns.length} result{visibleRuns.length === 1 ? '' : 's'} for “{q.trim()}” (full-text)
          </p>
        )}
        {/* The filters are a tablist; "Mark all read" is an ACTION and sits
            outside it — it used to be the last child with `marginLeft:auto`,
            so on a wrap it stranded on its own row next to a ragged gap, and
            a screen reader counted it as a sixth filter. */}
        <div className="filter-bar">
          <div className="filter-chips" role="tablist" aria-label="Filter by outcome">
            {(Object.keys(FILTER_LABELS) as OutcomeFilter[]).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                id={f === 'needsyou' ? APPROVALS_SURFACE.anchorId : undefined}
                className={filter === f ? 'on' : ''}
                onClick={() => setFilter(f)}
              >
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>
          <button className="filter-action" onClick={markAllRead} title="Mark all as read">
            Mark all read
          </button>
        </div>

        {approvals.error && (
          <div className="error-banner" role="alert">
            Couldn’t load approvals: {approvals.error}
            <div>
              <button className="btn small" style={{ marginTop: 8 }} onClick={approvals.reload}>
                Retry
              </button>
            </div>
          </div>
        )}
        {(approvals.data?.length ?? 0) > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="chip needs-you" style={{ display: 'inline-block', marginBottom: 6 }}>
              NEEDS YOU — {approvals.data!.length} pending
            </div>
            {approvals.data!.map((a) => (
              <ApprovalCard key={a.id} approval={a} onChanged={approvals.reload} />
            ))}
          </div>
        )}

        {runs.loading && (
          <div className="state-line">
            <span className="spinner" /> Loading runs…
          </div>
        )}
        {runs.error && (
          <div className="error-banner" role="alert">
            Couldn’t load runs: {runs.error}
            <div>
              <button className="btn small" style={{ marginTop: 8 }} onClick={runs.reload}>
                Retry
              </button>
            </div>
          </div>
        )}
        {!runs.loading && !runs.error && visibleRuns.length === 0 && (
          <div className="empty">
            {emptyMessageFor(q, filter, (runs.data ?? []).length)}
          </div>
        )}
        {grouped.map(([label, rows]) => (
          <div key={label}>
            <div className="mb-1 mt-2 text-xxs font-semibold uppercase tracking-wider text-dim">
              {label} · {rows.length}
            </div>
            {rows.map((r: RunRowT) => {
              const spec = safeJson(r.jobspec_json);
              const unread = isUnread(r, lastRead);
              return (
                <div
                  key={r.id}
                  className={`inbox-row ${selected === r.id ? 'sel' : ''} ${unread ? 'unread' : ''}`}
                  onClick={() => selectRun(r.id)}
                  data-testid={`run-${r.state}`}
                >
                  <strong>{spec.taskName}</strong>
                  <div className="meta">
                    <span className={`chip ${chipFor(r.state)}`}>{stateLabel(r.state)}</span>
                    {needsYouRunIds.has(r.id) && !['waiting_approval', 'awaiting_user'].includes(r.state) && (
                      <span className="chip needs-you">awaiting your decision</span>
                    )}
                    {r.state === 'failed' && r.outcome_reason && (
                      <span className="mono" style={{ color: 'var(--danger, #c0392b)' }} title={FAILURE_GUIDANCE[r.outcome_reason]?.next}>
                        {r.outcome_reason.replace('_', ' ')}
                      </span>
                    )}
                    <span className="mono">{fmtCost(r.cost_usd, spec.engine, 2, '—')}</span>
                    <span>{fmtTs(r.scheduled_for ?? r.started_at)}</span>
                    {ftsOrder?.get(r.id) && <span title={ftsOrder.get(r.id)}>🔎 match</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="report">
        {!selected && digest && (
          <MorningDigest digest={digest} onOpenRun={selectRun} onMarkAllRead={markAllRead} />
        )}
        {!selected && !digest && <div className="empty">Select a run to read its report.</div>}
        {/* Opening an exception replaces the digest with a report, and there is
            no other way back to it — App.tsx owns the tabs, so the digest has
            to live in this pane. Without this the digest is a screen you can
            read exactly once per morning. */}
        {selected && digest && (
          <button
            className="btn small"
            data-testid="digest-back"
            onClick={() => setSelected(null)}
          >
            ← While you were away
          </button>
        )}
        {/* `key` is load-bearing, not a lint appeasement. ReportDetail keeps
            the previous run's data on screen while a refetch is in flight (so
            an SSE frame cannot blank the live tail — see the guards inside
            it), and the ONLY thing that then stops the old run's report being
            shown under a new run's id is remounting on the id. */}
        {selected && (
          <ReportDetail
            key={selected}
            runId={selected}
            version={version}
            approvals={(approvals.data ?? []).filter((a) => String(a.run_id) === selected)}
            onApprovalChanged={approvals.reload}
          />
        )}
      </div>
    </div>
  );
}

/** Module-level deep-link handoff: App toast click → InboxView auto-select. */
let pendingRunId: string | null = null;
export function setPendingRunId(runId: string): void {
  pendingRunId = runId;
  // nudge any mounted InboxView; if not mounted, it reads pendingRunId on mount
  window.dispatchEvent(new CustomEvent('clockwork:open-run', { detail: runId }));
}

/** How many exception rows the digest shows before deferring to the list. */
const DIGEST_EXCEPTIONS_SHOWN = 6;

/** The window's lower bound, in the words a person would use. */
function fmtDigestSince(since: number): string {
  if (since <= 0) return 'you first opened Clockwork';
  return new Date(since).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One screen for the morning after (T4-9).
 *
 * The question this answers is "did the night go well", and it has to answer
 * it without the reader opening anything. So: the exceptions come FIRST and
 * carry their own reason, the totals come second, and the one sentence that
 * matters when nothing went wrong is said outright rather than left to be
 * inferred from an absence.
 *
 * It lives in the report pane because that is the Inbox's landing slot and
 * `App.tsx` — which owns the tabs — belongs to another change. Every row is a
 * button into the run it names, so "exceptions first" is a route and not just
 * an ordering.
 */
function MorningDigest({
  digest,
  onOpenRun,
  onMarkAllRead,
}: {
  digest: DigestT;
  onOpenRun: (runId: string) => void;
  onMarkAllRead: () => void;
}): JSX.Element {
  const wentWrong = digest.exceptions.filter((e) => e.kind === 'went_wrong').length;
  const shown = digest.exceptions.slice(0, DIGEST_EXCEPTIONS_SHOWN);
  const hidden = digest.exceptions.length - shown.length;

  return (
    <div className="overnight-digest" data-testid="inbox-digest">
      <h2>While you were away</h2>
      <p className="hint" data-testid="digest-since">
        Everything since you last read the inbox — {fmtDigestSince(digest.since)}.
      </p>

      {digest.exceptions.length === 0 ? (
        <p className="ok-banner" data-testid="digest-all-clear">
          Nothing needs you. Every run in this window finished the way it was meant to.
        </p>
      ) : (
        <div data-testid="digest-exceptions">
          <div className="chip needs-you" style={{ display: 'inline-block', marginBottom: 6 }}>
            {digest.needsYou > 0 ? `${digest.needsYou} waiting on you` : ''}
            {digest.needsYou > 0 && wentWrong > 0 ? ' · ' : ''}
            {wentWrong > 0 ? `${wentWrong} did not finish cleanly` : ''}
          </div>
          {shown.map((e) => (
            // A button, not the list's `div` + onClick, because this row is
            // the digest's whole point of contact and must be reachable from
            // the keyboard. `w-full text-left` undoes the two UA defaults
            // Tailwind's preflight leaves on a button — shrink-to-fit width
            // and centred text — so it lays out exactly like `.inbox-row`.
            <button
              key={e.runId}
              className="inbox-row w-full text-left"
              data-testid={`digest-exception-${e.kind}`}
              onClick={() => onOpenRun(e.runId)}
            >
              <strong>{e.taskName}</strong>
              <span className="meta">
                <span className={`chip ${e.kind === 'needs_you' ? 'needs-you' : chipFor(e.state)}`}>
                  {e.kind === 'needs_you' ? 'Waiting for you' : stateLabel(e.state)}
                </span>
                {e.kind === 'went_wrong' && e.reason && (
                  <span className="mono" title={FAILURE_GUIDANCE[e.reason]?.next}>
                    {e.reason.replace(/_/g, ' ')}
                  </span>
                )}
                <span>{fmtTs(e.at)}</span>
              </span>
            </button>
          ))}
          {hidden > 0 && (
            <p className="hint" data-testid="digest-exceptions-more">
              {hidden} more in the list on the left.
            </p>
          )}
        </div>
      )}

      <div className="statrow mono" data-testid="digest-totals">
        <span>{digest.runs} {digest.runs === 1 ? 'run' : 'runs'}</span>
        <span>{digest.completed} completed</span>
        {/* Said only when it is true, and never folded into a rate: an
            unfinished run is real spend and a real run, and nothing else. */}
        {digest.inFlight > 0 && (
          <span data-testid="digest-inflight">{digest.inFlight} still running</span>
        )}
      </div>
      <div className="statrow mono" data-testid="digest-spend">
        <span>${digest.costUsd.toFixed(2)} spent</span>
        {digest.costUnreported > 0 && (
          <span data-testid="digest-cost-unreported">
            {digest.costUnreported} {digest.costUnreported === 1 ? 'run reports' : 'runs report'} no cost
          </span>
        )}
        {digest.branchesWaiting > 0 && (
          <span data-testid="digest-branches">
            {digest.branchesWaiting} {digest.branchesWaiting === 1 ? 'branch' : 'branches'} waiting for review
          </span>
        )}
        {digest.successRate !== null && <span>{digest.successRate}% of finished runs completed</span>}
      </div>

      <div className="mt-2">
        <button className="btn small" data-testid="digest-mark-read" onClick={onMarkAllRead}>
          Mark all read
        </button>
      </div>
    </div>
  );
}

/**
 * The commands the report can honestly offer for a run's branch.
 *
 * COPIED, never run. The daemon has no route that executes git for the user
 * and this file is not the place to invent one, so each command is rendered
 * in full beside its button — readable before it is used, and usable where
 * the clipboard is denied.
 *
 * The gate is `committedSomething`, NOT `run.branch`: the column is written
 * for every repo run whether or not it committed (run-manager.ts:983), and an
 * analysis-only run's branch is deleted at finalize (run-manager.ts:765-767).
 * Keyed off the column alone this would hand a user `git checkout` for a
 * branch git no longer has.
 *
 * `baseBranch` is nullable in a real jobspec (schemas.ts JobSpec), so the two
 * commands that need a base are absent rather than guessed when it is missing.
 */
export interface NextCommandT {
  id: string;
  label: string;
  command: string;
  /** shown under the command when running it needs a human's judgement first */
  caveat?: string;
}

export function nextCommandsFor(
  spec: Pick<JobSpecViewT, 'repoPath' | 'baseBranch'>,
  branch: string | null,
  committedSomething: boolean,
): NextCommandT[] {
  const repoPath = spec.repoPath ?? null;
  if (!committedSomething || !branch || !repoPath) return [];
  const out: NextCommandT[] = [
    { id: 'checkout', label: 'Check out the branch', command: `git -C ${repoPath} checkout ${branch}` },
  ];
  if (spec.baseBranch) {
    out.push({
      id: 'diff',
      label: 'Read the diff',
      command: `git -C ${repoPath} diff ${spec.baseBranch}...${branch}`,
    });
    out.push({
      id: 'pr',
      label: 'Open a pull request',
      command: `cd ${repoPath} && git push -u origin ${branch} && gh pr create --base ${spec.baseBranch} --head ${branch} --fill`,
      caveat:
        'Read this one before running it. The run never pushed the branch, and “origin” is an assumption — Clockwork is not told this repository’s remotes.',
    });
  }
  return out;
}

/**
 * What to do next, in the report (T4-6).
 *
 * The north-star metric is accepted outcomes per user per week — a run whose
 * output the user ACTED on — and until now the report ended at a summary, a
 * diffstat and some stats. Everything here is an action the data already on
 * this screen supports; nothing claims a capability the daemon lacks.
 *
 * "Run it again" is `POST /tasks/:id/run-now`, one click. Its refusals are
 * shown rather than swallowed — the plan-then-execute gate answers 409 for an
 * execute half whose pair is unapproved (api.ts `planExecuteGate`), and a
 * button that quietly did nothing would be worse than no button. It does not
 * navigate on its own: a report that jumped elsewhere while you were reading
 * it is a report you stop trusting.
 *
 * ORDER IS PARTLY A GUESS, and it is flagged as one. That branch actions come
 * before "Run it again" falls out of the data rather than out of a preference:
 * a run that left a branch left it BECAUSE the branch is the outcome, and a
 * run with no branch has nothing else to offer. Which of checkout / diff / PR
 * belongs first is the part a week of real mornings answers.
 */
function ReportActions({
  run,
  spec,
  report,
}: {
  run: RunRowT;
  spec: JobSpecViewT;
  report: RunReportViewT | null;
}): JSX.Element {
  const branch = run.branch ?? report?.branch ?? null;
  const commands = nextCommandsFor(spec, branch, report?.committedSomething === true);
  const [copied, setCopied] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookedRunId, setBookedRunId] = useState<string | null>(null);

  const copy = async (c: NextCommandT): Promise<void> => {
    try {
      await navigator.clipboard.writeText(c.command);
      setCopied(c.id);
    } catch {
      // Denied or unavailable. The command is on screen and selectable, so
      // this is a convenience, not the path.
      setCopied(null);
    }
  };

  const runAgain = async (): Promise<void> => {
    setBooking(true);
    setBookError(null);
    setBookedRunId(null);
    try {
      const booked = await api.runNow(run.task_id);
      setBookedRunId(booked.runId);
    } catch (e) {
      setBookError(e instanceof Error ? e.message : String(e));
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="report-actions mt-4 border-t border-border pt-3" data-testid="report-actions">
      <h3 className="section-title">Next</h3>
      {commands.length === 0 && (
        <p className="hint" data-testid="report-actions-no-branch">
          {spec.repoPath
            ? 'This run committed nothing, so there is no branch to review.'
            : 'This run had no repository, so there is no branch to review.'}
        </p>
      )}
      {commands.map((c) => (
        <div key={c.id} className="report-action mt-2" data-testid={`report-action-${c.id}`}>
          <button
            className="btn small"
            data-testid={`report-action-copy-${c.id}`}
            onClick={() => void copy(c)}
          >
            {copied === c.id ? 'Copied' : c.label}
          </button>{' '}
          <code className="mono">{c.command}</code>
          {c.caveat && <p className="hint">{c.caveat}</p>}
        </div>
      ))}
      <div className="mt-2">
        <button
          className="btn small"
          data-testid="report-action-rerun"
          disabled={booking}
          onClick={() => void runAgain()}
        >
          {booking ? 'Booking…' : 'Run it again'}
        </button>
      </div>
      {bookError && (
        <div className="error-banner" role="alert" data-testid="report-action-rerun-error">
          Couldn’t book another run: {bookError}
        </div>
      )}
      {bookedRunId && (
        <div className="ok-banner" data-testid="report-action-rerun-ok">
          Booked.{' '}
          <button className="btn small" onClick={() => setPendingRunId(bookedRunId)}>
            Open the new run
          </button>
        </div>
      )}
    </div>
  );
}

function ReportDetail({
  runId,
  version,
  approvals = [],
  onApprovalChanged,
}: {
  runId: string;
  version: number;
  /** unresolved approvals belonging to THIS run, so a decision can be made here */
  approvals?: any[];
  onApprovalChanged?: () => void;
}): JSX.Element {
  const detail = useAsync(() => api.report(runId), [runId, version]);
  const tr = useAsync(
    () => (detail.data ? api.transcript(runId) : Promise.resolve({ available: false, lines: [] })),
    [runId, Boolean(detail.data)],
  );
  const [showTr, setShowTr] = useState(false);

  // `&& !detail.data` on both guards, and that is the whole reason the live
  // tail can accumulate. App.tsx bumps `version` on EVERY SSE frame, so a
  // chatty run re-runs this fetch constantly; on a bare `detail.loading` the
  // component returned the spinner each time, unmounting LiveTail and
  // throwing away every line it had collected. Keeping the previous report on
  // screen during a refetch is also what a person expects — the report did
  // not stop existing because a newer one is being fetched. Same for a
  // transient error: a failed refresh must not erase a good report.
  if (detail.loading && !detail.data) {
    return <div className="state-line"><span className="spinner" /> Loading report…</div>;
  }
  if (detail.error && !detail.data) {
    return (
      <div className="error-banner" role="alert">
        Couldn’t load report: {detail.error}
        <div><button className="btn small" style={{ marginTop: 8 }} onClick={detail.reload}>Retry</button></div>
      </div>
    );
  }
  if (!detail.data) return <div className="empty">No report available.</div>;

  const { run, report } = detail.data;
  const spec: JobSpecViewT = safeJson(run.jobspec_json);
  const active = isRunActive(run.state);
  // `report` stays untyped: the JSX below reads a dozen more fields off it
  // through `?.` chains that a narrow optional type would reject. This is the
  // slice ReportActions needs, and only that slice is described.
  const reportView: RunReportViewT | null = report ?? null;

  return (
    <>
      <h2>{spec.taskName}</h2>
      <div className="statrow mono">
        <span className={`chip ${chipFor(run.state)}`}>{stateLabel(run.state)}</span>
        {run.outcome_reason && <span>reason: {run.outcome_reason}</span>}
        <span>{fmtCost(run.cost_usd, spec.engine, 4, 'not reported')}</span>
        <span>{run.turns} turns</span>
        {run.started_at && run.ended_at && (
          <span>{Math.round((run.ended_at - run.started_at) / 1000)}s</span>
        )}
        {run.branch && <span>{run.branch}</span>}
      </div>

      <TaskMemoryPanel taskId={run.task_id} runId={runId} version={version} />

      {/* Above the tail on purpose: an approval that arrives while you are
          watching the run work is the one thing you must not have to go
          looking for. Same card the inbox list uses, so the decision is
          answerable here without navigating anywhere. */}
      {approvals.length > 0 && (
        <div data-testid="run-needs-you" role="alert">
          <div className="chip needs-you" style={{ display: 'inline-block', marginBottom: 6 }}>
            NEEDS YOU — {approvals.length === 1 ? 'this run is waiting on you' : `${approvals.length} decisions waiting`}
          </div>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} onChanged={onApprovalChanged ?? (() => {})} />
          ))}
        </div>
      )}

      {active && (
        <LiveTail runId={runId} costUsd={run.cost_usd} turns={run.turns} engine={spec.engine} />
      )}
      {report?.summary ? (
        <div className="summary-block">{report.summary}</div>
      ) : (
        <div className="empty">Report not finalized yet — check back once the run completes.</div>
      )}
      <FailureBanner reason={run.outcome_reason} />
      {/* Actions, then the verdict, in that order and directly under the
          summary. Reading the summary is what earns a verdict, so accept /
          reject sits below it rather than above; and it sits ABOVE the
          diffstat, the deliveries and the transcript, because the F6 verdict
          is what F7's autonomy ladder, F10's timesheets and F11's scorecards
          all read, and a verdict you have to scroll for is a verdict nobody
          records. */}
      {!active && <ReportActions run={run} spec={spec} report={reportView} />}
      {!active && <OutcomeControls runId={runId} />}
      {report?.sandboxed === false && (
        <div className="error-banner" role="alert">
          <strong>Sandbox was off for this run</strong> (CW_SANDBOX=off). Writes and credential reads were not contained.
        </div>
      )}
      {/* T1-9, beside the sandbox banner because it is the same kind of news:
          a guarantee the run was booked under did not hold. */}
      {describeSleep(report) && (
        <div className="error-banner" role="alert" data-testid="run-slept">
          {describeSleep(report)}
        </div>
      )}
      {report?.worktreeState?.preserved && report.worktreeState.reason !== 'committed' && (
        <div className="hint mono">
          Worktree preserved at {report.worktreeState.path}
          {report.worktreeState.interruptedOp
            ? ` — interrupted during ${report.worktreeState.interruptedOp}; inspect before the next run touches it`
            : report.worktreeState.dirty
              ? ' — uncommitted changes left behind'
              : ' — the run was interrupted, so nothing was pruned'}
        </div>
      )}

      {report?.diffStat?.length > 0 && (
        <table className="diffstat-table mono">
          <tbody>
            {report.diffStat.map((s: any) => (
              <tr key={s.path}>
                <td>{s.path}</td>
                <td className="add">+{s.additions}</td>
                <td className="del">−{s.deletions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* The parenthetical here used to read "(machine slept)". `ranLateMs` is
          the gap between the booked time and the start, and it measures
          nothing about sleep: a queued run, a held repo mutex or a daemon
          restart produce it too. Guessing a cause is the same defect T1-9
          fixes one line above — where a sleep IS measured, the banner says so
          in its own words. */}
      {report?.ranLateMs > 0 && (
        <p className="hint">⏰ Ran {Math.round(report.ranLateMs / 60000)}m late.</p>
      )}
      {report?.coveredOccurrences?.length > 0 && (
        <p className="hint">Covers {report.coveredOccurrences.length} missed occurrence(s).</p>
      )}
      {report?.deliveries?.length > 0 && (
        <p className="hint">
          Delivered:{' '}
          {report.deliveries.map((d: any) => `${d.channel}${d.ok ? ' ✓' : ` ✗ (${d.error ?? '?'})`}`).join(', ')}
        </p>
      )}
      <ProposedEvents runId={runId} events={report?.proposedEvents ?? []} />
      {/* T4-6 finding: `runs.branch` is written for EVERY repo run whether or
          not it committed (run-manager.ts:983), and an analysis-only run's
          branch is deleted at finalize (run-manager.ts:765-767). Gating on
          run.branch alone therefore named a branch git no longer has. The
          report's own committedSomething is the only field that says work
          survived, and it is what the next-action commands gate on too. */}
      {run.branch && run.state === 'completed' && report?.committedSomething && (
        <p className="ok-banner mono">Branch ready for review: {run.branch}</p>
      )}

      {tr.data?.available && (
        <div className="transcript">
          <button className="btn small" onClick={() => setShowTr((s) => !s)}>
            {showTr ? 'Hide transcript' : `Show transcript (${tr.data.totalLines ?? '?'} lines)`}
          </button>
          {showTr && <pre>{tr.data.lines.join('\n')}</pre>}
        </div>
      )}

      {!active && <ProofOfWorkExport runId={runId} />}
    </>
  );
}

/** How much of a run's output the tail holds. Older lines live in the journal. */
const TAIL_MAX_LINES = 200;
/** Within this many pixels of the bottom still counts as "following". */
const TAIL_STICK_PX = 24;

interface TailLine {
  at: number;
  text: string;
}

/**
 * The live run view (T4-1): what the agent is saying, right now.
 *
 * Two sources, because neither is enough alone. `run.log` over SSE only
 * carries what happens after this component mounts, so a tab opened mid-run
 * would start blank and never recover the earlier output; `GET
 * /runs/:id/events` serves the journal the daemon has been appending to since
 * the run started. The subscription is registered FIRST and the seed fetched
 * alongside it, never in sequence — a line that lands during the fetch is
 * then merely shown twice at the seam, where waiting would have lost it.
 *
 * The daemon coalesces log lines into ~10 frames/sec per run
 * (run-manager.ts LOG_COALESCE_MS), so a frame carries an ARRAY of lines and
 * one timestamp for the batch; within a 100ms window that stamp is the line's
 * own time to the precision anybody reads it at.
 */
function LiveTail({
  runId,
  costUsd,
  turns,
  engine,
}: {
  runId: string;
  costUsd: number | null;
  turns: number;
  engine: string | undefined;
}): JSX.Element {
  const [seed, setSeed] = useState<{ lines: TailLine[]; earlierHidden: boolean } | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [live, setLive] = useState<TailLine[]>([]);
  // Following the output, or has the user scrolled up to read something?
  const [following, setFollowing] = useState(true);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const onSse = (e: Event): void => {
      const ev = (e as CustomEvent).detail as { type?: string; runId?: string; lines?: unknown; at?: number };
      if (ev?.type !== 'run.log' || ev.runId !== runId || !Array.isArray(ev.lines)) return;
      const at = typeof ev.at === 'number' ? ev.at : Date.now();
      const batch = (ev.lines as unknown[]).filter((l): l is string => typeof l === 'string').map((text) => ({ at, text }));
      if (batch.length === 0) return;
      setLive((ls) => [...ls, ...batch].slice(-TAIL_MAX_LINES));
    };
    window.addEventListener('clockwork:sse', onSse);
    return () => window.removeEventListener('clockwork:sse', onSse);
  }, [runId]);

  useEffect(() => {
    let alive = true;
    api
      .runEvents(runId)
      .then((r) => {
        if (!alive) return;
        setSeed({
          lines: r.lines.map((l) => ({ at: l.at, text: l.text })).slice(-TAIL_MAX_LINES),
          earlierHidden: r.from > 0 || r.skipped > 0 || r.lines.length > TAIL_MAX_LINES,
        });
      })
      .catch((e) => {
        // Say so rather than showing an empty box that looks like a quiet run.
        if (alive) setSeedError(e?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  const lines = useMemo(
    () => [...(seed?.lines ?? []), ...live].slice(-TAIL_MAX_LINES),
    [seed, live],
  );

  useEffect(() => {
    const el = preRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, following]);

  const onScroll = (): void => {
    const el = preRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_STICK_PX);
  };

  const jumpToLatest = (): void => {
    setFollowing(true);
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="live-tail" data-testid="live-tail">
      <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="spinner" /> Live output
        <span className="mono" data-testid="live-tail-cost">
          {fmtCost(costUsd, engine, 4, 'not reported')}
        </span>
        <span className="mono" data-testid="live-tail-turns">
          {turns} {turns === 1 ? 'turn' : 'turns'}
        </span>
        {!following && (
          <button className="btn small" data-testid="live-tail-follow" onClick={jumpToLatest}>
            Paused — jump to latest
          </button>
        )}
      </div>
      {seedError && (
        <p className="hint" data-testid="live-tail-seed-error">
          Earlier output couldn’t be loaded ({seedError}) — showing what arrives from here on.
        </p>
      )}
      {seed?.earlierHidden && (
        <p className="hint">Showing the last {TAIL_MAX_LINES} lines — the full output is in the transcript.</p>
      )}
      {lines.length === 0 ? (
        <p className="hint">Waiting for output…</p>
      ) : (
        <pre
          ref={preRef}
          onScroll={onScroll}
          className="mono"
          data-testid="live-tail-output"
          style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}
        >
          {lines.map((l, i) => (
            <div key={i}>
              <span style={{ color: 'var(--dim)' }}>{l.at ? `${new Date(l.at).toLocaleTimeString()} ` : ''}</span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function fmtTs(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * OpenCode exposes no usage telemetry, so its runs always record cost_usd as
 * a literal 0 (packages/runner/src/opencode-runner.ts:1-6) — not "no data",
 * but "no data, reported as zero". Showing "$0.00" reads as a real, cheap
 * run rather than an unmeasured one, so opencode (and any genuinely absent
 * cost) renders as unreported instead of a dollar amount.
 */
function fmtCost(costUsd: number | null | undefined, engine: string | undefined, digits: number, placeholder: string): string {
  if (engine === 'opencode' || costUsd === null || costUsd === undefined) return placeholder;
  return `$${Number(costUsd).toFixed(digits)}`;
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function todayMidnightLocal(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** ⌘K focuses the inbox search from anywhere. */
function KeyFocus(): null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('inbox-search-input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

/** Humanized failure guidance — honest next-steps per failure class. */
const FAILURE_GUIDANCE: Record<string, { title: string; next: string }> = {
  capacity: {
    title: 'Provider limit reached',
    next: 'Your plan’s usage window is exhausted. Wait for the reset shown below, or book the next run on a different provider in the composer.',
  },
  auth: {
    title: 'Not signed in',
    next: 'Open your provider CLI once to re-login, then press “Run now” on the task.',
  },
  max_turns: {
    title: 'Stopped at the turn cap',
    next: 'The agent needed more steps than allowed. Raise “Max turns” on the task, or narrow the prompt.',
  },
  timed_out: {
    title: 'Ran past its timeout',
    next: 'Increase “Timeout s” if the job genuinely needs longer.',
  },
  budget_exceeded: {
    title: 'Spent past the budget cap',
    next: 'Raise the USD soft cap, or narrow scope so fewer tokens are needed.',
  },
  repo_preflight: {
    title: 'Repository problem',
    next: 'Check that the path exists, has commits, and the base branch resolves.',
  },
};

function FailureBanner({ reason }: { reason: string | null }): JSX.Element | null {
  const g = reason ? FAILURE_GUIDANCE[reason] : undefined;
  if (!g) return null;
  return (
    <div className="error-banner" role="alert">
      <strong>{g.title}.</strong> {g.next}
    </div>
  );
}
