/**
 * Inbox (T-124): run reports with FTS-backed search, outcome filters,
 * unread tracking, approvals with REAL respond actions (within the child's
 * decision window), report detail with transcript viewer.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type RunRowT } from '../api';
import { useAsync } from '../useAsync';

type OutcomeFilter = 'all' | 'completed' | 'failed' | 'active' | 'needsyou';

const UNREAD_KEY = 'clockwork.inbox.lastRead';

function chipFor(state: string): string {
  if (state === 'completed') return 'completed';
  if (['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state)) return 'failed';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'running';
  if (['waiting_approval', 'awaiting_user'].includes(state)) return 'needs-you';
  return '';
}

function matchesFilter(state: string, f: OutcomeFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'completed': return state === 'completed';
    case 'failed': return ['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state);
    case 'active': return ['running', 'queued', 'preparing', 'finalizing'].includes(state);
    case 'needsyou': return ['waiting_approval', 'awaiting_user'].includes(state);
  }
}

export default function InboxView({ version }: { version: number }): JSX.Element {
  const runs = useAsync(() => api.runs({ limit: 200 }), [version]);
  const approvals = useAsync(() => api.approvals(), [version]);
  const [selected, setSelected] = useState<string | null>(null);
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

  const visibleRuns = useMemo(() => {
    let rows = runs.data ?? [];
    if (ftsOrder) {
      rows = [...rows].sort((a, b) => {
        const ai = ftsOrder.has(a.id) ? 0 : 1;
        const bi = ftsOrder.has(b.id) ? 0 : 1;
        return ai - bi;
      }).filter((r) => ftsOrder.has(r.id));
    }
    return rows.filter((r) => matchesFilter(r.state, filter));
  }, [runs.data, ftsOrder, filter]);

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
        <input
          className="inbox-search"
          placeholder="Search runs (full-text)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="inbox-search"
          aria-label="Search runs"
        />
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
            {q ? `No runs match “${q}”.` : 'No runs yet. Book one from the calendar.'}
          </div>
        )}
        {visibleRuns.map((r: RunRowT) => {
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
                <span className="mono">${Number(r.cost_usd ?? 0).toFixed(2)}</span>
                <span>{fmtTs(r.scheduled_for ?? r.started_at)}</span>
                {ftsOrder?.get(r.id) && <span title={ftsOrder.get(r.id)}>🔎 match</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="report">
        {!selected && <div className="empty">Select a run to read its report.</div>}
        {selected && <ReportDetail runId={selected} version={version} />}
      </div>
    </div>
  );
}

function ApprovalCard({ approval, onChanged }: { approval: any; onChanged: () => void }): JSX.Element {
  const payload = typeof approval.payload_json === 'string' ? safeJson(approval.payload_json) : approval.payload_json ?? {};
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const respond = async (decision: 'approved' | 'denied'): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.respondApproval(approval.id, decision);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-card">
      <strong>Permission request</strong>
      <div className="meta mono" style={{ color: 'var(--dim)', fontSize: 12, margin: '3px 0' }}>
        {String(payload.tool ?? '').slice(0, 100)}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Answer within the engine’s decision window (~2 min) to steer this live run. After that it is
        auto-denied (unattended fail-safe) and shown for audit.
      </p>
      {err && <div className="error-banner">{err}</div>}
      <div className="approval-actions">
        <button className="btn primary small" disabled={busy} onClick={() => void respond('approved')}>
          Approve
        </button>
        <button className="btn danger small" disabled={busy} onClick={() => void respond('denied')}>
          Deny
        </button>
      </div>
    </div>
  );
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

  return (
    <>
      <h2>{spec.taskName}</h2>
      <div className="statrow mono">
        <span className={`chip ${chipFor(run.state)}`}>{run.state.replace('_', ' ')}</span>
        {run.outcome_reason && <span>reason: {run.outcome_reason}</span>}
        <span>${Number(run.cost_usd ?? 0).toFixed(4)}</span>
        <span>{run.turns} turns</span>
        {run.started_at && run.ended_at && (
          <span>{Math.round((run.ended_at - run.started_at) / 1000)}s</span>
        )}
        {run.branch && <span>{run.branch}</span>}
      </div>

      {report?.summary ? (
        <div className="summary-block">{report.summary}</div>
      ) : (
        <div className="empty">Report not finalized yet — check back once the run completes.</div>
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
    </>
  );
}

function fmtTs(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
