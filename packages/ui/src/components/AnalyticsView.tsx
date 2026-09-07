/**
 * AnalyticsView (ADR-029): cost & reliability intelligence.
 * Answers: what did AI cost me? which task costs the most? success rates?
 *
 * Also the mount point for F10 (timesheets) and F11 (performance reviews),
 * as an internal sub-tab switcher rather than a second top-level nav entry:
 * App.tsx owns routing/nav and is frozen for this change, and 'analytics' is
 * the only tab that already reaches this file — so this is the sole
 * reachable path to F10/F11. Both share this view's existing days selector
 * rather than inventing a second range control.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { Segmented } from './ui/segmented';
import TimesheetsPanel from './TimesheetsPanel';
import { TIMESHEETS_SURFACE } from './TimesheetsPanel';
import PerformanceReviewsPanel from './PerformanceReviewsPanel';
import { PERFORMANCE_REVIEWS_SURFACE } from './PerformanceReviewsPanel';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * The overview itself — cost & reliability totals, daily spend, by-task and
 * by-provider breakdowns. Always the default sub-view, so its anchor (the
 * page title) is unconditionally rendered.
 */
export const ANALYTICS_BASIC_SURFACE = registerFeatureSurface({
  key: 'analytics_basic',
  tab: 'analytics',
  where: 'Analytics › Overview',
  anchorId: 'analytics-basic',
});

type SubView = 'overview' | 'timesheets' | 'performance';

interface Analytics {
  range: { from: number; to: number; days: number };
  totals: { runs: number; completed: number; failed: number; successRate: number; costUsd: number; turns: number; avgCostPerRun: number };
  byTask: Array<{ taskId: string; name: string; runs: number; completed: number; failed: number; costUsd: number; successRate: number; avgDurationMs: number }>;
  byProvider: Array<{ engine: string; runs: number; completed: number; failed: number; costUsd: number; successRate: number }>;
  daily: Array<{ day: string; runs: number; costUsd: number }>;
  suggestions?: Array<{ taskName: string; kind: string; message: string }>;
}

export default function AnalyticsView({ version }: { version: number }): JSX.Element {
  const [view, setView] = useState<SubView>('overview');
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (view !== 'overview') return;
    let alive = true;
    setData(null);
    api.analytics(days)
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e: Error) => { if (alive) setErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [version, days, view]);

  const maxDailyCost = data ? Math.max(...data.daily.map((d) => d.costUsd), 0.0001) : 1;

  return (
    <div style={{ width: '100%', maxWidth: 'none' }}>
      <div className="tasks-toolbar">
        <h3 className="section-title" style={{ margin: 0 }} id={ANALYTICS_BASIC_SURFACE.anchorId}>Analytics</h3>
        <Segmented
          aria-label="Analytics section"
          value={view}
          onChange={setView}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'timesheets', label: 'Timesheets', id: TIMESHEETS_SURFACE.anchorId },
            { value: 'performance', label: 'Performance reviews', id: PERFORMANCE_REVIEWS_SURFACE.anchorId },
          ]}
        />
        <span className="grow" />
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger aria-label="Time range" className="w-auto h-8 text-caption">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {view === 'timesheets' && <TimesheetsPanel version={version} days={days} />}
      {view === 'performance' && <PerformanceReviewsPanel version={version} days={days} />}

      {view === 'overview' && err && <div className="error-banner" role="alert">{err}</div>}
      {view === 'overview' && !data && !err && <div className="state-line"><span className="spinner" /> Computing analytics…</div>}

      {view === 'overview' && data && (
        <>
          {/* headline numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
            <StatCard label="Total spend" value={`$${data.totals.costUsd.toFixed(4)}`} />
            <StatCard label="Runs" value={String(data.totals.runs)} sub={`${data.totals.completed} ✓ · ${data.totals.failed} ✗`} />
            <StatCard label="Success rate" value={`${data.totals.successRate}%`} />
            <StatCard label="Avg cost / run" value={`$${data.totals.avgCostPerRun.toFixed(4)}`} />
            <StatCard label="Total turns" value={String(data.totals.turns)} />
          </div>

          {/* daily cost bars */}
          {data.daily.length > 0 && (
            <>
              <h3 className="section-title">Daily spend</h3>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110, marginBottom: 20 }} role="img" aria-label="Daily cost bar chart">
                {data.daily.map((d) => (
                  <div
                    key={d.day}
                    title={`${d.day}: ${d.runs} runs · $${d.costUsd.toFixed(4)}`}
                    style={{
                      flex: 1,
                      height: `${Math.max(4, (d.costUsd / maxDailyCost) * 100)}%`,
                      background: 'var(--accent, #e8a33d)',
                      borderRadius: 3,
                      minHeight: 3,
                      opacity: 0.85,
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {/* optimization suggestions (goal #35) */}
          {data.suggestions && data.suggestions.length > 0 && (
            <>
              <h3 className="section-title">Optimization suggestions</h3>
              <div style={{ marginBottom: 20 }}>
                {data.suggestions.map((s, i) => (
                  <div key={i} className="tasklist-row" style={{ alignItems: 'flex-start' }}>
                    <span className="chip needs-you">{s.kind === 'failing_task' ? 'fix' : s.kind === 'prompt_scoping' ? 'scope' : 'cheaper'}</span>
                    <div className="grow">
                      <div>{s.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* by provider */}
          {data.byProvider.length > 0 && (
            <>
              <h3 className="section-title">By provider</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20, fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
                    <th style={{ padding: '6px 8px' }}>Engine</th>
                    <th style={{ padding: '6px 8px' }}>Runs</th>
                    <th style={{ padding: '6px 8px' }}>Success</th>
                    <th style={{ padding: '6px 8px' }}>Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProvider.map((p) => (
                    <tr key={p.engine} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px' }}>{p.engine}</td>
                      <td style={{ padding: '6px 8px' }}>{p.runs}</td>
                      <td style={{ padding: '6px 8px' }}>{p.successRate}%</td>
                      <td style={{ padding: '6px 8px' }}>${p.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* by task — answers "which agent wastes money?" */}
          <h3 className="section-title">By task (sorted by spend)</h3>
          {data.byTask.length === 0 ? (
            <div className="empty">No runs in this window yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
                  <th style={{ padding: '6px 8px' }}>Task</th>
                  <th style={{ padding: '6px 8px' }}>Runs</th>
                  <th style={{ padding: '6px 8px' }}>Success</th>
                  <th style={{ padding: '6px 8px' }}>Avg duration</th>
                  <th style={{ padding: '6px 8px' }}>Spend</th>
                </tr>
              </thead>
              <tbody>
                {data.byTask.map((t) => (
                  <tr key={t.taskId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px' }}>{t.name}</td>
                    <td style={{ padding: '6px 8px' }}>{t.runs}</td>
                    <td style={{ padding: '6px 8px', color: t.failed > t.completed ? 'var(--danger)' : undefined }}>{t.successRate}%</td>
                    <td style={{ padding: '6px 8px' }}>{t.avgDurationMs ? `${Math.round(t.avgDurationMs / 1000)}s` : '—'}</td>
                    <td style={{ padding: '6px 8px' }}>${t.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="tasklist-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <span className="hint" style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <strong style={{ fontSize: 19 }}>{value}</strong>
      {sub && <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>{sub}</span>}
    </div>
  );
}
