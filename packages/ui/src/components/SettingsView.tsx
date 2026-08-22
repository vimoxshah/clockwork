/**
 * Settings (T-125): theme picker (light/dark/system, persisted), pause state
 * loaded from the server (not guessed), snapshot stats, engine statement.
 */
import { useTheme } from '../theme';
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
        <button className={`btn ${paused ? 'primary' : 'danger'}`} disabled={busy || health.loading} onClick={() => void togglePause()}>
          {paused ? 'Resume' : 'Pause all'}
        </button>
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

      <h3 className="section-title" style={{ marginTop: 20 }}>Execution</h3>
      <p className="hint">
        Engine: your own Claude Code via <span className="mono">claude -p</span> on your subscription
        login — no API key required. Every run is OS-sandboxed with writes locked to its worktree,
        SSH keys unreadable, and hard budget bounds.
      </p>
    </div>
  );
}
