/**
 * TimesheetsPanel (F10, plan/AGENT-WORKFORCE-SPEC.md): a punch clock per
 * agent — hours worked, dollars spent, outcomes accepted, and an effective
 * hourly rate compared against what the user's own time is worth.
 *
 * Mounted as an Analytics sub-tab (AnalyticsView) rather than a top-level
 * route: App.tsx owns the nav/routing and is frozen for this change, so this
 * is the only reachable path to F10.
 *
 * KNOWN ACCURACY CAVEAT (must not be hidden): `hoursWorked` is
 * `ended_at - started_at` summed over runs (daemon: timesheets.ts). A run
 * that was active when the daemon restarted is closed out by the recovery
 * sweep with `ended_at = <restart time>` and `outcome_reason = 'orphaned'`
 * (run-manager.ts recoverySweep) — so its clock kept counting for the entire
 * time the daemon was down, not just the time it actually ran. That inflates
 * both hoursWorked and effectiveHourlyRateUsd for the affected agent.
 *
 * The caveat below is shown UNCONDITIONALLY next to the totals, because the
 * per-row flag is best-effort only: `GET /runs` is capped at 1000 rows and
 * only carries the jobspec's frozen `profile.id`, not the live
 * `run_outcomes.profile_id` the daemon's own grouping prefers, so a orphaned
 * run for a profile that was reassigned since could be missed. When the
 * cross-reference succeeds we additionally flag the specific rows it found,
 * as a stronger signal than the blanket caveat alone.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TimesheetT, TimesheetRowT } from '../api';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { registerFeatureSurface } from './featureSurfaces';

/** Mounted as the Analytics "Timesheets" sub-tab — see AnalyticsView's Segmented switcher. */
export const TIMESHEETS_SURFACE = registerFeatureSurface({
  key: 'agent_timesheets',
  tab: 'analytics',
  where: 'Analytics › Timesheets',
  anchorId: 'agent-timesheets',
});

/**
 * Best-effort profile id out of a run's frozen jobspec snapshot — the same
 * `$.profile.id` field the daemon's own COALESCE fallback reads
 * (timesheets.ts). A parse failure or unexpected shape falls back to `null`
 * (the "Unassigned" bucket), matching the daemon's own behaviour for a run
 * with no profile at all.
 */
function profileIdFromJobspec(jobspecJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(jobspecJson);
    if (parsed !== null && typeof parsed === 'object' && 'profile' in parsed) {
      const profile = (parsed as { profile?: unknown }).profile;
      if (profile !== null && typeof profile === 'object' && 'id' in profile) {
        const id = (profile as { id?: unknown }).id;
        if (typeof id === 'string') return id;
      }
    }
  } catch {
    // corrupt/legacy jobspec — treat as no profile, same as the daemon does
  }
  return null;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div style={{ flex: '1 1 140px' }}>
      <span className="hint" style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <div><strong style={{ fontSize: 17 }}>{value}</strong></div>
      {sub && <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>{sub}</span>}
    </div>
  );
}

/** Signed, colored delta of an agent's effective rate against the human's own. */
function RateComparison({ effective, human }: { effective: number | null; human: number | null }): JSX.Element {
  if (effective === null) return <span className="hint" style={{ margin: 0 }}>—</span>;
  if (human === null) return <span className="hint" style={{ margin: 0 }}>set your rate to compare</span>;
  const delta = effective - human;
  if (Math.abs(delta) < 0.005) return <span className="hint" style={{ margin: 0 }}>about even</span>;
  const cheaper = delta < 0;
  return (
    <span style={{ color: cheaper ? 'var(--success)' : 'var(--danger)', fontSize: 12.5 }}>
      ${Math.abs(delta).toFixed(2)}/hr {cheaper ? 'cheaper than you' : 'pricier than you'}
    </span>
  );
}

export default function TimesheetsPanel({ version, days }: { version: number; days: number }): JSX.Element {
  const [data, setData] = useState<TimesheetT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [orphanCounts, setOrphanCounts] = useState<Map<string | null, number> | null>(null);

  const [rateInput, setRateInput] = useState('');
  const [rateBusy, setRateBusy] = useState(false);
  const [rateErr, setRateErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    setOrphanCounts(null);
    const to = Date.now();
    const from = to - days * 86_400_000;

    void (async () => {
      const [tsResult, runsResult] = await Promise.allSettled([
        api.timesheet({ from, to }),
        api.runs({ state: 'failed', limit: 1000 }),
      ]);
      if (!alive) return;

      if (tsResult.status === 'fulfilled') {
        setData(tsResult.value);
        setRateInput(tsResult.value.humanHourlyRateUsd != null ? String(tsResult.value.humanHourlyRateUsd) : '');
        setErr(null);
      } else {
        const reason = tsResult.reason as Error;
        setErr(String(reason?.message ?? reason));
      }

      // Best-effort only — see file header. A failed cross-reference simply
      // means no rows get the extra chip; the caveat text still stands.
      if (runsResult.status === 'fulfilled') {
        const counts = new Map<string | null, number>();
        for (const r of runsResult.value) {
          if (r.outcome_reason !== 'orphaned') continue;
          if (r.ended_at == null || r.ended_at < from || r.ended_at >= to) continue;
          const pid = profileIdFromJobspec(r.jobspec_json);
          counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
        setOrphanCounts(counts);
      }
    })();

    return () => { alive = false; };
  }, [version, days]);

  const canSaveRate = rateInput.trim() !== '' && Number.isFinite(Number(rateInput)) && Number(rateInput) >= 0;

  const saveRate = async (): Promise<void> => {
    setRateBusy(true);
    setRateErr(null);
    try {
      const r = await api.setHumanHourlyRate(Number(rateInput));
      setData((d) => (d ? { ...d, humanHourlyRateUsd: r.humanHourlyRateUsd } : d));
    } catch (e) {
      setRateErr(String((e as Error).message ?? e));
    } finally {
      setRateBusy(false);
    }
  };

  const clearRate = async (): Promise<void> => {
    setRateBusy(true);
    setRateErr(null);
    try {
      const r = await api.setHumanHourlyRate(null);
      setData((d) => (d ? { ...d, humanHourlyRateUsd: r.humanHourlyRateUsd } : d));
      setRateInput('');
    } catch (e) {
      setRateErr(String((e as Error).message ?? e));
    } finally {
      setRateBusy(false);
    }
  };

  const totalSpend = data ? data.rows.reduce((s, r) => s + r.dollarsSpent, 0) : 0;
  const totalHours = data ? data.rows.reduce((s, r) => s + r.hoursWorked, 0) : 0;
  const totalAccepted = data ? data.rows.reduce((s, r) => s + r.outcomesAccepted, 0) : 0;
  const totalRejected = data ? data.rows.reduce((s, r) => s + r.outcomesRejected, 0) : 0;

  return (
    <div>
      {err && <div className="error-banner" role="alert">{err}</div>}
      {!data && !err && <div className="state-line"><span className="spinner" /> Computing timesheets…</div>}

      {data && (
        <>
          <div className="tasklist-row" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ flex: '1 1 220px' }}>
              <span className="hint" style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Your hourly rate</span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  placeholder="e.g. 75"
                  aria-label="Your hourly rate in USD"
                  style={{ width: 100, height: 32 }}
                  data-testid="human-rate-input"
                />
                <Button size="sm" disabled={!canSaveRate || rateBusy} onClick={() => void saveRate()} data-testid="human-rate-save">
                  Save
                </Button>
                {data.humanHourlyRateUsd !== null && (
                  <Button size="sm" variant="outline" disabled={rateBusy} onClick={() => void clearRate()} data-testid="human-rate-clear">
                    Clear
                  </Button>
                )}
              </div>
              {data.humanHourlyRateUsd === null ? (
                <p className="hint" style={{ marginTop: 4 }}>
                  Set your rate to see whether each agent is actually cheaper than doing the work yourself.
                </p>
              ) : (
                <p className="hint" style={{ marginTop: 4 }}>
                  Compared against ${data.humanHourlyRateUsd.toFixed(2)}/hr below.
                </p>
              )}
              {rateErr && <div className="error-banner" role="alert" style={{ marginTop: 6 }}>{rateErr}</div>}
            </div>

            <Stat label="Total spend" value={`$${totalSpend.toFixed(4)}`} />
            <Stat label="Hours worked" value={totalHours.toFixed(2)} />
            <Stat label="Outcomes" value={`${totalAccepted} accepted`} sub={`${totalRejected} rejected`} />
          </div>

          <p className="hint" data-testid="hours-caveat" style={{ marginBottom: 16 }}>
            Hours are wall-clock start→end. A run interrupted by a daemon restart keeps counting until the
            daemon comes back online, so its hours — and its effective hourly rate — can be inflated. Treat a
            row flagged "interrupted" below as an upper bound, not an exact figure.
          </p>

          {data.rows.length === 0 ? (
            <div className="empty">
              No runs in this window yet. Book a task against an agent profile and its punch clock — hours,
              spend, and outcomes — shows up here.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
                  <th style={{ padding: '6px 8px' }}>Agent</th>
                  <th style={{ padding: '6px 8px' }}>Runs</th>
                  <th style={{ padding: '6px 8px' }}>Hours</th>
                  <th style={{ padding: '6px 8px' }}>Spend</th>
                  <th style={{ padding: '6px 8px' }}>Outcomes</th>
                  <th style={{ padding: '6px 8px' }}>Effective rate</th>
                  <th style={{ padding: '6px 8px' }}>vs. you</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row: TimesheetRowT) => {
                  const interrupted = orphanCounts?.get(row.profileId) ?? 0;
                  return (
                    <tr key={row.profileId ?? '__unassigned__'} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px' }}>
                        {row.profileName}
                        {interrupted > 0 && (
                          <span
                            className="chip failed"
                            style={{ marginLeft: 6 }}
                            title={`${interrupted} run(s) for this agent were interrupted by a daemon restart in this window — their hours run until the restart, not until they actually stopped`}
                            data-testid="orphaned-chip"
                          >
                            {interrupted} interrupted
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{row.runs}</td>
                      <td style={{ padding: '6px 8px' }}>{row.hoursWorked.toFixed(2)}</td>
                      <td style={{ padding: '6px 8px' }}>${row.dollarsSpent.toFixed(4)}</td>
                      <td style={{ padding: '6px 8px' }}>{row.outcomesAccepted} ✓ · {row.outcomesRejected} ✗</td>
                      <td style={{ padding: '6px 8px' }}>
                        {row.effectiveHourlyRateUsd === null ? '—' : `$${row.effectiveHourlyRateUsd.toFixed(2)}/hr`}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <RateComparison effective={row.effectiveHourlyRateUsd} human={data.humanHourlyRateUsd} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
