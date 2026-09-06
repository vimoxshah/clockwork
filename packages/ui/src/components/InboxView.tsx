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
import { ProofOfWorkExport } from './ProofOfWorkExport';
import { TaskMemoryPanel } from './TaskMemoryPanel';

type OutcomeFilter = 'all' | 'completed' | 'failed' | 'active' | 'needsyou';

const UNREAD_KEY = 'clockwork.inbox.lastRead';

function chipFor(state: string): string {
  if (state === 'completed') return 'completed';
  if (['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state)) return 'failed';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'running';
  if (['waiting_approval', 'awaiting_user'].includes(state)) return 'needs-you';
  return '';
}

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
  };

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
        <div className="filter-chips" role="tablist" aria-label="Filter by outcome">
          {(['all', 'completed', 'failed', 'active', 'needsyou'] as OutcomeFilter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'needsyou' ? 'needs you' : f}
            </button>
          ))}
          <button style={{ marginLeft: 'auto' }} onClick={markAllRead} title="Mark all as read">
            mark read
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
              const unread = (r.ended_at ?? r.started_at ?? 0) > lastRead && r.state !== 'running' && r.state !== 'queued';
              return (
                <div
                  key={r.id}
                  className={`inbox-row ${selected === r.id ? 'sel' : ''} ${unread ? 'unread' : ''}`}
                  onClick={() => selectRun(r.id)}
                  data-testid={`run-${r.state}`}
                >
                  <strong>{spec.taskName}</strong>
                  <div className="meta">
                    <span className={`chip ${chipFor(r.state)}`}>{r.state.replace('_', ' ')}</span>
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
        {!selected && <div className="empty">Select a run to read its report.</div>}
        {selected && <ReportDetail runId={selected} version={version} />}
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

function ReportDetail({ runId, version }: { runId: string; version: number }): JSX.Element {
  const detail = useAsync(() => api.report(runId), [runId, version]);
  const tr = useAsync(
    () => (detail.data ? api.transcript(runId) : Promise.resolve({ available: false, lines: [] })),
    [runId, Boolean(detail.data)],
  );
  const [showTr, setShowTr] = useState(false);

  if (detail.loading) {
    return <div className="state-line"><span className="spinner" /> Loading report…</div>;
  }
  if (detail.error) {
    return (
      <div className="error-banner" role="alert">
        Couldn’t load report: {detail.error}
        <div><button className="btn small" style={{ marginTop: 8 }} onClick={detail.reload}>Retry</button></div>
      </div>
    );
  }
  if (!detail.data) return <div className="empty">No report available.</div>;

  const { run, report } = detail.data;
  const spec = safeJson(run.jobspec_json);
  const active = ['running', 'preparing', 'finalizing', 'waiting_approval', 'awaiting_user'].includes(run.state);

  return (
    <>
      <h2>{spec.taskName}</h2>
      <div className="statrow mono">
        <span className={`chip ${chipFor(run.state)}`}>{run.state.replace('_', ' ')}</span>
        {run.outcome_reason && <span>reason: {run.outcome_reason}</span>}
        <span>{fmtCost(run.cost_usd, spec.engine, 4, 'not reported')}</span>
        <span>{run.turns} turns</span>
        {run.started_at && run.ended_at && (
          <span>{Math.round((run.ended_at - run.started_at) / 1000)}s</span>
        )}
        {run.branch && <span>{run.branch}</span>}
      </div>

      <TaskMemoryPanel taskId={run.task_id} runId={runId} version={version} />

      {active && <LiveTail runId={runId} />}
      {report?.summary ? (
        <div className="summary-block">{report.summary}</div>
      ) : (
        <div className="empty">Report not finalized yet — check back once the run completes.</div>
      )}
      <FailureBanner reason={run.outcome_reason} />
      {!active && <OutcomeControls runId={runId} />}
      {report?.sandboxed === false && (
        <div className="error-banner" role="alert">
          <strong>Sandbox was off for this run</strong> (CW_SANDBOX=off). Writes and credential reads were not contained.
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
      {report?.ranLateMs > 0 && (
        <p className="hint">⏰ Ran {Math.round(report.ranLateMs / 60000)}m late (machine slept).</p>
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
      {run.branch && run.state === 'completed' && (
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

/** Live streaming output: subscribes to run.log SSE events for this run while it executes. */
function LiveTail({ runId }: { runId: string }): JSX.Element {
  const [lines, setLines] = useState<Array<{ at: number; line: string }>>([]);
  const preRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const onSse = (e: Event): void => {
      const ev = (e as CustomEvent).detail as { type?: string; runId?: string; line?: string; at?: number };
      if (ev?.type === 'run.log' && ev.runId === runId && typeof ev.line === 'string') {
        setLines((ls) => [...ls.slice(-200), { at: ev.at ?? Date.now(), line: ev.line as string }]);
      }
    };
    window.addEventListener('clockwork:sse', onSse);
    return () => window.removeEventListener('clockwork:sse', onSse);
  }, [runId]);
  // auto-scroll to the newest line
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className="live-tail" data-testid="live-tail">
      <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="spinner" /> Live output
      </div>
      {lines.length === 0 ? (
        <p className="hint">Waiting for output…</p>
      ) : (
        <pre ref={preRef} className="mono" style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}>
          {lines.map((l, i) => (
            <div key={i}>
              <span style={{ color: 'var(--dim)' }}>{new Date(l.at).toLocaleTimeString()} </span>
              {l.line}
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
