/**
 * Clockwork shell: topbar + tab navigation (hash-persisted), connect gate,
 * error boundary, SSE-driven refresh counter, theme provider.
 */
import { Component, useEffect, useState, type ReactNode } from 'react';
import { api, openEventStream, setToken } from './api';
import { ThemeProvider } from './theme';
import CalendarView from './components/CalendarView';
import InboxView from './components/InboxView';
import TasksView from './components/TasksView';
import ComposerView from './components/ComposerView';
import SettingsView from './components/SettingsView';
import type { Health } from './api';

type Tab = 'calendar' | 'inbox' | 'tasks' | 'new' | 'settings';
const TABS: Tab[] = ['calendar', 'inbox', 'tasks', 'new', 'settings'];

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#/', '').replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'calendar';
}

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [health, setHealth] = useState<Health | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  // hash → tab; tab → hash (state survives reload)
  useEffect(() => {
    const onHash = (): void => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (tabFromHash() !== tab) window.location.hash = `#/${tab}`;
  }, [tab]);

  // health poll
  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setUnauthorized(false);
        }
      } catch {
        if (alive) setHealth(null);
      }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [unauthorized]);

  // unauthorized events from any API call → connect gate
  useEffect(() => {
    const onUnauth = (): void => setUnauthorized(true);
    window.addEventListener('clockwork:unauthorized', onUnauth);
    return () => window.removeEventListener('clockwork:unauthorized', onUnauth);
  }, []);

  // live refresh over SSE — every state change bumps dataVersion so views refetch
  useEffect(() => {
    if (unauthorized || !localStorage.getItem('clockwork.token')) return;
    const es = openEventStream((e) => {
      if (e.type === 'daemon.health' && e.data) {
        setHealth((h) => (h ? { ...h, ...e.data } : h));
      }
      setDataVersion((v) => v + 1);
    });
    es.onerror = () => {
      /* EventSource auto-reconnects; health poll covers outages */
    };
    return () => es.close();
  }, [unauthorized]);

  const hasToken = Boolean(localStorage.getItem('clockwork.token'));

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {!hasToken || unauthorized ? (
          <ConnectGate
            onConnected={() => {
              setUnauthorized(false);
              setDataVersion((v) => v + 1);
            }}
          />
        ) : (
          <>
            <header className="flex h-12 items-center gap-4 border-b border-border bg-surface px-4">
              <div className="wordmark text-[13px]">
                CLOCK<b>WORK</b>
              </div>
              <nav className="tabs flex gap-1" aria-label="Sections">
                {TABS.map((t) => (
                  <button
                    key={t}
                    className={
                      'rounded-lg px-3 py-1.5 text-[13px] transition-colors ' +
                      (tab === t
                        ? 'bg-surface-active font-medium text-fg'
                        : 'text-muted hover:bg-surface-hover hover:text-fg')
                    }
                    onClick={() => setTab(t)}
                  >
                    {t === 'new' ? '+ New task' : t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </nav>
              <div style={{ flex: 1 }} />
              <div className="health mono flex items-center gap-3.5 text-xs text-dim" data-testid="health">
                <span>
                  <span className={`dot ${health?.ok ? '' : 'down'}`} />
                  {health ? `daemon ${health.daemonVersion}` : 'daemon down'}
                </span>
                {health && (
                  <>
                    <span>{health.activeRuns} running</span>
                    <span>{health.queuedRuns} queued</span>
                    {health.paused && <span className="chip needs-you">PAUSED</span>}
                    {health.nextFire && (
                      <span>next {new Date(health.nextFire).toLocaleTimeString()}</span>
                    )}
                  </>
                )}
              </div>
            </header>
            <main className="main">
              {tab !== 'new' && <OnboardingGate version={dataVersion} onBook={() => setTab('new')} />}
              {tab === 'calendar' && (
                <CalendarView
                  version={dataVersion}
                  onBookOnDate={(prefill) => {
                    composerPrefill = prefill;
                    setTab('new');
                  }}
                  onOpenTask={() => setTab('tasks')}
                />
              )}
              {tab === 'inbox' && <InboxView version={dataVersion} />}
              {tab === 'tasks' && <TasksView version={dataVersion} />}
              {tab === 'new' && (
                <ComposerView
                  prefill={composerPrefill}
                  onDone={() => {
                    composerPrefill = null;
                    setTab('calendar');
                  }}
                />
              )}
              {tab === 'settings' && <SettingsView version={dataVersion} />}
            </main>
          </>
        )}
      </ErrorBoundary>
    </ThemeProvider>
  );
}

/** Module-level prefill handoff calendar → composer. */
let composerPrefill: { runAtLocal: string } | null = null;

/** FR-21: first-run environment detection. */
function OnboardingGate({ version, onBook }: { version: number; onBook: () => void }): JSX.Element | null {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.onboardingStatus>> | null>(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('cw.onboard.dismissed') === '1');
  useEffect(() => {
    void api.onboardingStatus().then(setStatus).catch(() => {});
  }, [version]);
  if (!status || dismissed || status.hasTasks) return null;
  return (
    <div className="onboard">
      <strong>Welcome to Clockwork</strong>
      <p className="hint" style={{ margin: '6px 0' }}>
        Runs execute when this Mac is awake — for overnight jobs, plug in or use an always-on machine.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: 13 }}>
        <li>{status.claudeInstalled ? '✅' : '❌'} Claude Code installed{status.claudeInstalled ? '' : ' — install the claude CLI and log in once'}</li>
        <li>{status.claudeAuthed ? '✅' : '⚠️'} Claude auth detected {status.claudeAuthed ? '(subscription login — no API key needed)' : '(run `claude` interactively once to authenticate)'}</li>
        <li>{status.gitInstalled ? '✅' : '❌'} git available</li>
        <li>ℹ️ MCP config {status.mcpDetected ? 'detected' : 'not found (optional)'}</li>
      </ul>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {!status.hasTasks && (
          <button className="btn primary small" onClick={onBook}>
            Book your first run
          </button>
        )}
        <button
          className="btn small"
          onClick={() => {
            sessionStorage.setItem('cw.onboard.dismissed', '1');
            setDismissed(true);
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function ConnectGate({ onConnected }: { onConnected: () => void }): JSX.Element {
  const [tokenInput, setTokenInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setToken(tokenInput.trim());
    try {
      await api.health();
      onConnected();
    } catch (e) {
      clearStoredToken();
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 20px' }}>
      <h2>Connect to daemon</h2>
      <p className="hint">
        Paste the API token from <span className="mono">~/.clockwork/api-token</span> to pair this UI
        with your local clockworkd.
      </p>
      <input
        data-testid="token-input"
        type="text"
        value={tokenInput}
        onChange={(e) => setTokenInput(e.target.value)}
        placeholder="API token"
        aria-label="API token"
        onKeyDown={(e) => e.key === 'Enter' && void connect()}
      />
      {err && (
        <div className="error-banner" role="alert">
          {err}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}

import { clearToken as clearStoredToken } from './api';

interface EBState {
  err: Error | null;
}
class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { err: null };
  static getDerivedStateFromError(err: Error): EBState {
    return { err };
  }
  render(): ReactNode {
    if (this.state.err) {
      return (
        <div style={{ maxWidth: 560, margin: '80px auto', padding: '0 20px' }}>
          <h2>Something broke</h2>
          <pre
            className="mono"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              overflow: 'auto',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {this.state.err.message}
          </pre>
          <p className="hint">Your data is safe in ~/.clockwork. Reload to try again.</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
