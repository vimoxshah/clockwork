/**
 * Settings (T-125): theme picker (light/dark/system, persisted), pause state
 * loaded from the server (not guessed), snapshot stats, engine statement.
 */
import { useState } from 'react';
import { useTheme } from '../theme';
import { Switch } from './ui/switch';
import { Badge } from './ui/card';
import { api } from '../api';
import { useAsync } from '../useAsync';

export default function SettingsView({ version }: { version: number }): JSX.Element {
  const { pref, setPref } = useTheme();
  const health = useAsync(() => api.health(), [version]);
  const snap = useAsync(() => api.snapshot(), [version]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const paused = health.data?.paused ?? false;

  const togglePause = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      if (paused) await api.resume();
      else await api.pauseAll();
      health.reload();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <h3 className="section-title">Appearance</h3>
      <div className="tasklist-row">
        <div className="grow">
          <strong>Theme</strong>
          <div className="hint">Applies everywhere immediately; “system” follows your OS.</div>
        </div>
        <div className="theme-toggle" role="radiogroup" aria-label="Theme">
          {(['light', 'dark', 'system'] as const).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={pref === p}
              className={pref === p ? 'on' : ''}
              onClick={() => setPref(p)}
            >
              {p === 'light' ? '☀︎ light' : p === 'dark' ? '☾ dark' : '◐ system'}
            </button>
          ))}
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: 20 }}>Scheduling</h3>
      {health.error && <div className="error-banner">Couldn’t load daemon state: {health.error}</div>}
      <div className="tasklist-row">
        <div className="grow">
          <strong>Pause all scheduling</strong>
          <div className="hint">
            Queued and future runs hold until resumed. Active runs finish. Currently:{' '}
            <strong>{paused ? 'PAUSED' : 'running'}</strong>.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch
            checked={paused}
            disabled={busy || health.loading}
            onCheckedChange={() => void togglePause()}
            aria-label="Pause all scheduling"
          />
          {paused ? 'Paused' : 'Active'}
        </label>
      </div>
      {err && <div className="error-banner">{err}</div>}

      {snap.data && (
        <div className="statrow mono" style={{ marginTop: 14 }}>
          <span>runs today: {snap.data.runsToday}</span>
          <span>needs you: {snap.data.needsYou}</span>
          {snap.data.nextRun?.name && (
            <span>next: {snap.data.nextRun.name}</span>
          )}
        </div>
      )}

      <h3 className="section-title" style={{ marginTop: 20 }}>Usage &amp; limits</h3>
      <UsageCard version={version} />

      <h3 className="section-title" style={{ marginTop: 20 }}>Execution</h3>
      <p className="hint">
        Engine: your own Claude Code via <span className="mono">claude -p</span> on your subscription
        login — no API key required. Every run is OS-sandboxed with writes locked to its worktree,
        SSH keys unreadable, and hard budget bounds.
      </p>
    </div>
  );
}

/** FR-7 estimate-grade usage panel: real telemetry from live runs' rate_limit_event. */
function UsageCard({ version }: { version: number }): JSX.Element {
  const usage = useAsync(() => api.usageStatus(), [version]);
  const providers = useAsync(() => api.providers(), [version]);

  if (usage.error) return <div className="error-banner">{usage.error}</div>;
  if (usage.loading) return <p className="hint">Reading telemetry…</p>;

  const windows = usage.data?.windows ?? [];
  if (windows.length === 0) {
    return (
      <p className="hint">
        No provider-limit telemetry yet. Clockwork records 5-hour and weekly window usage from live
        runs, then suggests which provider to schedule with (estimate-grade).
      </p>
    );
  }
  const fmtReset = (ts: number | null): string =>
    ts ? new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="space-y-2">
      {windows.map((w) => (
        <div key={w.kind} className="tasklist-row">
          <div className="grow">
            <strong>{w.kind === 'seven_day' ? 'Weekly window' : w.kind === 'five_hour' ? '5-hour window' : w.kind}</strong>
            <div className="hint" style={{ margin: 0 }}>
              observed {new Date(w.at).toLocaleTimeString()} · resets {fmtReset(w.resetsAt as number)}
              {w.usedPct != null ? ` · used ${Math.round(w.usedPct)}%` : ''}
            </div>
          </div>
          <Badge variant={w.source.includes('rejected') ? 'danger' : 'success'} style={{}}>
            {w.source.includes('rejected') ? 'limit hit' : 'ok'}
          </Badge>
        </div>
      ))}
      <AdvisorNote windows={windows} providers={providers.data ?? []} />
      <p className="hint">Estimate-grade heuristic from your own runs — never a guarantee (FR-7).</p>
    </div>
  );
}

function AdvisorNote({
  windows,
  providers,
}: {
  windows: Array<{ kind: string; source: string }>;
  providers: Array<{ id: string; label: string; detected: boolean }>;
}): JSX.Element {
  const claudeLimited = windows.some((w) => w.source.includes('rejected'));
  const alt = providers.filter((p) => p.detected && p.id !== 'cli');
  if (!claudeLimited || alt.length === 0) {
    return (
      <div className="ok-banner">
        All windows healthy — keep scheduling on Claude. Tip: book long jobs inside a fresh 5-hour
        window for maximum headroom.
      </div>
    );
  }
  return (
    <div className="error-banner">
      Claude limit hit recently. Advisor:{' '}
      {alt.map((a) => `schedule on ${a.label} until reset`).join(' or ')}. Booked tasks can switch
      provider in the composer.
    </div>
  );
}
