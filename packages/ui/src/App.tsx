/**
 * Clockwork shell: topbar + tab navigation (hash-persisted), connect gate,
 * error boundary, SSE-driven refresh counter, theme provider.
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, openEventStream, setToken } from './api';
import { ThemeProvider } from './theme';
import CalendarView from './components/CalendarView';
import AgentsView from './components/AgentsView';
import InboxView, { setPendingRunId } from './components/InboxView';
import { CommandPalette, useGlobalShortcuts, type Command, type Tab as PaletteTab } from './components/CommandPalette';
import TasksView from './components/TasksView';
import ComposerView from './components/ComposerView';
import SettingsView from './components/SettingsView';
import AnalyticsView from './components/AnalyticsView';
import type { Health } from './api';

/**
 * The nine agent-workforce surfaces did NOT earn a tab. Each one belongs to a
 * section that already exists, and it belongs there for a reason the user
 * already understands:
 *
 *   Settings   office hours, earned autonomy   — they configure the workforce
 *   Analytics  timesheets, performance cards   — they measure it
 *   Tasks      sentinels, repo jobs, plan/exec — they create and hold work
 *   Inbox      proof-of-work, shift handoff    — they hang off one run
 *
 * A tab per feature would have made the shell a table of contents for our
 * backlog instead of a map of the product. Nothing was added here.
 */
type Tab = 'calendar' | 'inbox' | 'agents' | 'tasks' | 'analytics' | 'new' | 'settings';
const TABS: Tab[] = ['calendar', 'inbox', 'agents', 'tasks', 'analytics', 'new', 'settings'];

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#/', '').replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'calendar';
}

/**
 * The topbar's "next …" stamp. A bare clock time is a lie by omission: with one
 * task booked for 20 Dec the header read `next 2:00:00 PM`, which is exactly
 * what a run fourteen minutes away would look like. Enough date to place the
 * time, and not a character more — this shares one 48px line with the daemon
 * version, two counters and the paused chip:
 *
 *   today                  `2:00 PM`
 *   the next six days      `Sun 2:00 PM`
 *   further out, this year `Dec 20, 2:00 PM`
 *   another year           `Dec 20, 2027, 2:00 PM`
 *
 * The comparison is between LOCAL CALENDAR DAYS, not over a rolling 24 hours,
 * so a run at 1am tomorrow never renders as if it were today. Seconds are gone
 * with the same reasoning: nothing here is decided on a second. The exact
 * instant stays available in the span's tooltip.
 */
export function formatNextFire(ts: number, now: Date = new Date()): string {
  const at = new Date(ts);
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded, because a DST boundary makes a calendar day 23 or 25 hours long.
  const daysAway = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  const clock = { hour: 'numeric', minute: '2-digit' } as const;
  if (daysAway === 0) return at.toLocaleTimeString(undefined, clock);
  if (daysAway > 0 && daysAway < 7) return at.toLocaleString(undefined, { weekday: 'short', ...clock });
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', ...clock })
    : at.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...clock });
}

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [health, setHealth] = useState<Health | null>(null);
  /** The daemon version this window first saw; see the health poll below. */
  const loadedDaemonVersion = useRef<string | null>(null);
  const [stalePage, setStalePage] = useState(false);
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
          // The daemon changed version underneath a window that is still
          // running the bundle it shipped before. `versionSkew` cannot see
          // this — that compares the daemon with the build on disk, and after
          // an upgrade-and-restart those two agree; it is THIS PAGE that is
          // behind. It is not cosmetic: a stale bundle keeps posting the old
          // payloads, and an "ASAP" task booked from a pre-0.10 window still
          // saved as the unfireable `queue` kind long after the daemon could
          // handle it. The page cannot fix itself, so it says so.
          setStalePage((was) => was || (loadedDaemonVersion.current ?? h.daemonVersion) !== h.daemonVersion);
          loadedDaemonVersion.current ??= h.daemonVersion;
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
  const [toasts, setToasts] = useState<Array<{ id: number; runId?: string; title: string; body: string; target: Tab }>>([]);
  useEffect(() => {
    if (unauthorized || !localStorage.getItem('clockwork.token')) return;
    const es = openEventStream((e) => {
      if (e.type === 'daemon.health' && e.data) {
        setHealth((h) => (h ? { ...h, ...e.data } : h));
      }
      // toast center: click navigates to the relevant surface (FR: app-grade notifications)
      let toast: { title: string; body: string; target: Tab } | null = null;
      if (e.type === 'report.ready') toast = { title: 'Run report ready', body: 'Click to review the report.', target: 'inbox' };
      else if (e.type === 'approval.requested') toast = { title: 'Needs your approval', body: 'A run is asking for permission.', target: 'inbox' };
      if (toast) {
        const runId = (e as any).runId as string | undefined;
        const id = Date.now() + Math.random();
        setToasts((ts) => [...ts.slice(-3), { id, runId, ...toast! }]);
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
      }
      setDataVersion((v) => v + 1);
    });
    es.onerror = () => {
      /* the stream reconnects with backoff; health poll covers outages */
    };
    return () => es.close();
  }, [unauthorized]);

  const hasToken = Boolean(localStorage.getItem('clockwork.token'));

  // Cmd+K command palette + global shortcuts
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcuts(
    useMemo(
      () => ({
        onPalette: () => setPaletteOpen((o) => !o),
        setTab: (t: PaletteTab) => setTab(t as Tab),
      }),
      [],
    ),
  );
  const commands: Command[] = useMemo(
    () => [
      { id: 'nav-calendar', label: 'Open Calendar', section: 'Navigate', shortcut: '⌘1', run: () => setTab('calendar') },
      { id: 'nav-inbox', label: 'Open Inbox', section: 'Navigate', shortcut: '⌘2', run: () => setTab('inbox') },
      { id: 'nav-tasks', label: 'Open Tasks', section: 'Navigate', shortcut: '⌘3', run: () => setTab('tasks') },
      { id: 'nav-agents', label: 'Open Agents', section: 'Navigate', shortcut: '⌘4', run: () => setTab('agents') },
      { id: 'new-task', label: 'New task', section: 'Create', shortcut: '⌘N', run: () => setTab('new') },
      { id: 'settings', label: 'Open Settings', section: 'Settings', shortcut: '⌘,', run: () => setTab('settings') },
      { id: 'theme-light', label: 'Theme: light', section: 'Settings', run: () => document.dispatchEvent(new CustomEvent('clockwork:set-theme', { detail: 'light' })) },
      { id: 'theme-dark', label: 'Theme: dark', section: 'Settings', run: () => document.dispatchEvent(new CustomEvent('clockwork:set-theme', { detail: 'dark' })) },
      { id: 'theme-system', label: 'Theme: system', section: 'Settings', run: () => document.dispatchEvent(new CustomEvent('clockwork:set-theme', { detail: 'system' })) },
    ],
    [],
  );

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
              <div className="wordmark text-compact">
                CLOCK<b>WORK</b>
              </div>
              <nav className="tabs flex gap-1" aria-label="Sections">
                {TABS.map((t) => (
                  <button
                    key={t}
                    // aria-current is the selector the active styling hangs off
                    // (see .tabs button[aria-current] in styles.css), so the
                    // visual state and the announced state cannot drift apart.
                    aria-current={tab === t ? 'page' : undefined}
                    className={
                      'rounded-lg px-3 py-1.5 text-compact transition-colors ' +
                      (tab === t ? '' : 'text-muted hover:bg-surface-hover hover:text-fg')
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
                {health?.versionSkew && (
                  <span
                    className="chip needs-you"
                    title={`This daemon is running ${health.daemonVersion} but ${health.installedVersion} is installed. Restart it: launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon`}
                  >
                    RESTART NEEDED — daemon {health.daemonVersion}, build {health.installedVersion}
                  </span>
                )}
                {health && (
                  <>
                    <span>{health.activeRuns} running</span>
                    <span>{health.queuedRuns} queued</span>
                    {health.paused && <span className="chip needs-you">PAUSED</span>}
                    {health.nextFire && (
                      <span
                        data-testid="next-fire"
                        title={`Next scheduled run: ${new Date(health.nextFire).toLocaleString()}`}
                      >
                        next {formatNextFire(health.nextFire)}
                      </span>
                    )}
                  </>
                )}
              </div>
            </header>
            <main className="main">
              {/* First thing in main, on every tab — including 'new', which the
                  onboarding gate skips. A stale daemon breaks whatever the user
                  is doing, so it cannot be a per-section concern. */}
              <VersionSkewNotice health={health} />
              <StalePageNotice stale={stalePage} health={health} />
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
              {tab === 'agents' && <AgentsView version={dataVersion} />}
              {tab === 'tasks' && <TasksView version={dataVersion} />}
              {tab === 'analytics' && <AnalyticsView version={dataVersion} />}
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
            {/* toast center — top-right so it never covers form actions; auto-dismiss */}
            <div className="fixed right-4 top-14 z-40 flex flex-col gap-2">
              {toasts.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    if (t.runId) setPendingRunId(t.runId);
                    setTab(t.target);
                    setToasts((ts) => ts.filter((x) => x.id !== t.id));
                  }}
                  className="w-72 rounded-xl border border-strong bg-surface p-3 text-left shadow-2xl transition-transform hover:scale-[1.02]"
                >
                  <div className="text-compact font-semibold text-fg">🔔 {t.title}</div>
                  <div className="mt-0.5 text-xs text-muted">{t.body}</div>
                </button>
              ))}
            </div>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
          </>
        )}
      </ErrorBoundary>
    </ThemeProvider>
  );
}

/**
 * The stale-daemon trap (S-80), put in front of the person it is happening to.
 *
 * A long-lived daemon keeps serving the version it booted with while the build
 * on disk — and the UI bundle served out of that build — moves on. The browser
 * then runs a NEW frontend against an OLD API: every route added since the
 * running version answers 404, so the product fails in a dozen unrelated-looking
 * ways at once instead of one obvious way. That is not hypothetical; it cost
 * three days and looked like a dozen separate bugs. The daemon's drift watch
 * already reports it on stderr (main.ts startBuildDriftWatch), which nobody
 * reads, so /health carries `versionSkew` and this says it out loud.
 *
 * Deliberately NOT dismissable. A banner the user can hide is the silent
 * failure all over again; it goes away when the daemon is restarted and
 * /health stops reporting skew, and not one moment sooner.
 *
 * `versionSkew` is only true when BOTH versions are known and they differ, so
 * a daemon that cannot read its own build on disk shows nothing rather than
 * claiming a skew it cannot prove. A daemon older than the release that added
 * the field sends neither key, which reads as no skew — one restart closes
 * that gap for good.
 */
export function VersionSkewNotice({ health }: { health: Health | null }): JSX.Element | null {
  if (!health?.versionSkew) return null;
  return (
    <div className="error-banner" role="alert" data-testid="version-skew">
      <strong>Restart your daemon — it is older than the app you are looking at.</strong>
      <p style={{ margin: '6px 0' }}>
        clockworkd is still serving version {health.daemonVersion}, but version{' '}
        {health.installedVersion} is installed on disk. This window was built from{' '}
        {health.installedVersion} and is calling a {health.daemonVersion} API, so anything added
        since {health.daemonVersion} answers 404: buttons that do nothing, lists that never load,
        errors with no cause — all one problem wearing a dozen disguises. Your data in
        ~/.clockwork is fine.
      </p>
      <p style={{ margin: '6px 0' }}>Run this in a terminal to hand the slot to the new build:</p>
      <pre
        className="mono"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 10px',
          margin: 0,
          overflow: 'auto',
          fontSize: 12,
        }}
      >
        {'launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon'}
      </pre>
      <p className="hint" style={{ margin: '6px 0 0' }}>
        That stops the running daemon, which may be executing agent runs right now — pick a moment
        when nothing important is in flight.
      </p>
    </div>
  );
}

/**
 * The mirror image of VersionSkewNotice, and the half that was missing.
 *
 * That banner covers a NEW window against an OLD daemon. This one covers an
 * OLD window against a NEW daemon: the daemon was upgraded and restarted while
 * this page stayed open, so the page is still running the bundle it loaded
 * before. `versionSkew` is blind to it — after an upgrade the daemon and the
 * build on disk agree, and only the page is behind.
 *
 * It reached a user: the daemon was upgraded to a build where the composer's
 * "ASAP" saves a runnable one-off, but their open window still ran the older
 * bundle, so ASAP kept writing the `queue` kind the scheduler cannot fire. The
 * app looked broken and the fix was a reload nobody knew to do.
 *
 * Reload is offered rather than forced: a reload throws away whatever is typed
 * into the composer, and this window still works for everything the old bundle
 * already did.
 */
export function StalePageNotice({
  stale,
  health,
}: {
  stale: boolean;
  health: Health | null;
}): JSX.Element | null {
  if (!stale) return null;
  return (
    <div className="error-banner" role="alert" data-testid="stale-page">
      <strong>Reload this window — the daemon was upgraded under it.</strong>
      <p style={{ margin: '6px 0' }}>
        clockworkd is now serving version {health?.daemonVersion ?? 'a newer build'}, but this page
        is still running the interface it loaded earlier. Until you reload, buttons here behave the
        way the OLD build did — anything fixed in the new one is not fixed in this window. Your data
        in ~/.clockwork is fine.
      </p>
      <button className="btn primary" onClick={() => window.location.reload()}>
        Reload now
      </button>
    </div>
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
        {status.hasProvider
          ? <li>✅ Provider ready — you can book work now</li>
          : <li>⚠️ No AI provider connected yet — bring an API key or use your Claude subscription</li>}
      </ul>
      {!status.hasProvider && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          Prefer a different model? Settings → API providers connects Anthropic, OpenAI, Google,
          DeepSeek, and more in under a minute — keys stay in your Keychain, billed by the provider,
          never by Clockwork.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {!status.hasTasks && (
          <button className="btn primary small" onClick={onBook}>
            Book your first run
          </button>
        )}
        {!status.hasProvider && (
          <button className="btn small" onClick={() => { window.location.hash = '#/settings'; setDismissed(true); sessionStorage.setItem('cw.onboard.dismissed', '1'); }}>
            Connect a provider
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
      // Deliberately an AUTHED route. This gate used to probe /health, which
      // `requiresAuth` leaves open on purpose — so it answered 200 to any
      // string, including an empty one, and the gate let the paste through.
      // The app then loaded and every real request 401'd, which reads as "the
      // app is broken" rather than "that is the wrong token". Verified against
      // a live daemon: a junk bearer gets 200 from /health and 401 from
      // /tasks. /capabilities is authed, bounded and ~2ms.
      await api.capabilities();
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
