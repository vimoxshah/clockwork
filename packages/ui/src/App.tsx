import { useEffect, useMemo, useState } from 'react';
import { api, openEventStream, setToken, type Health, type RunRowT, type TaskViewT } from './api';

type Tab = 'calendar' | 'inbox' | 'tasks' | 'new' | 'settings';

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('calendar');
  const [health, setHealth] = useState<Health | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [needToken, setNeedToken] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setNeedToken(false);
        }
      } catch {
        if (alive) setNeedToken(true);
      }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (needToken) return;
    const es = openEventStream((e) => {
      if (e.type === 'daemon.health') setHealth((h) => (h ? { ...h, ...e.data } : h));
      else setTick((t) => t + 1);
    });
    return () => es.close();
  }, [needToken]);

  const [, setTick] = useState(0);

  if (!localStorage.getItem('clockwork.token') && needToken) {
    return (
      <div className="main" style={{ maxWidth: 480, margin: '80px auto' }}>
        <h2>Connect to daemon</h2>
        <p className="hint">
          Paste the API token from <span className="mono">~/.clockwork/api-token</span> to pair this
          UI with your local clockworkd.
        </p>
        <input
          data-testid="token-input"
          type="text"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="API token"
        />
        <div style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={async () => {
              setToken(tokenInput.trim());
              try {
                await api.health();
                setNeedToken(false);
              } catch {
                setNeedToken(true);
              }
            }}
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          CLOCK<b>WORK</b>
        </div>
        <nav className="tabs">
          {(['calendar', 'inbox', 'tasks', 'new', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'new' ? '+ New task' : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="health mono" data-testid="health">
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
        <OnboardingGate />
        {tab === 'calendar' && <CalendarView />}
        {tab === 'inbox' && <InboxView />}
        {tab === 'tasks' && <TasksView />}
        {tab === 'new' && <Composer onDone={() => setTab('calendar')} />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </>
  );
}

/** FR-21: first-run environment detection + sample task guidance. */
function OnboardingGate(): JSX.Element | null {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.onboardingStatus>> | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    void api.onboardingStatus().then(setStatus).catch(() => {});
  }, []);
  if (!status || dismissed || status.hasTasks) return null;
  return (
    <div className="form-card" style={{ marginBottom: 18, background: 'var(--panel)', borderRadius: 10, padding: '12px 16px' }}>
      <strong>Welcome to Clockwork</strong>
      <p className="hint" style={{ margin: '6px 0' }}>
        Runs execute when this Mac is awake — for overnight jobs, plug in or use an always-on machine.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-mut)', fontSize: 13 }}>
        <li>{status.claudeInstalled ? '✅' : '❌'} Claude Code installed {status.claudeInstalled ? '' : '— install the claude CLI and log in once'}</li>
        <li>{status.claudeAuthed ? '✅' : '⚠️'} Claude auth detected {status.claudeAuthed ? '(subscription login — no API key needed)' : '(run `claude` interactively once to authenticate)'}</li>
        <li>{status.gitInstalled ? '✅' : '❌'} git available</li>
        <li>{status.mcpDetected ? 'ℹ️' : 'ℹ️'} MCP config {status.mcpDetected ? 'detected (per-task allow-lists in composer)' : 'not found (optional)'}</li>
      </ul>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => setDismissed(true)}>
        Got it
      </button>
    </div>
  );
}

// ---------- Calendar (T-122) ----------
function CalendarView(): JSX.Element {
  const [runs, setRuns] = useState<RunRowT[]>([]);
  const [tasks, setTasks] = useState<TaskViewT[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    void api.runs({ limit: 500 }).then(setRuns).catch(() => {});
    void api.tasks().then(setTasks).catch(() => {});
  }, []);

  // week containing today + offset; Monday start
  const days = useMemo(() => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [weekOffset]);

  const sameDay = (ts: number | null, d: Date): boolean =>
    ts != null && new Date(ts).toDateString() === d.toDateString();

  return (
    <div>
      <div className="cal-head">
        <button className="btn" onClick={() => setWeekOffset((w) => w - 1)}>
          ←
        </button>
        <button
          className="btn"
          onClick={() => setWeekOffset(0)}
          style={weekOffset === 0 ? { color: 'var(--brass)' } : {}}
        >
          Today
        </button>
        <button className="btn" onClick={() => setWeekOffset((w) => w + 1)}>
          →
        </button>
        <span style={{ color: 'var(--ink-mut)' }}>
          {days[0]!.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} –{' '}
          {days[6]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="cal-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const dayRuns = runs.filter((r) => sameDay(r.scheduled_for ?? r.started_at, d));
          const dayBookings = tasks.filter(
            (t) => t.enabled && sameDay(t.nextFire, d),
          );
          const isToday = d.toDateString() === new Date().toDateString();
          return (
            <div key={d.toISOString()} className={`cal-cell ${isToday ? 'today' : ''}`}>
              <div className="daynum">{d.getDate()}</div>
              {dayRuns.map((r) => {
                const name = JSON.parse(r.jobspec_json)?.taskName ?? r.task_id;
                return (
                  <div key={r.id} className={`cal-item ${r.state}`} title={`${name} — ${r.state}`}>
                    {name}
                  </div>
                );
              })}
              {dayBookings.map((t) => (
                <div key={t.id} className="cal-item booking" title={`${t.name} @ ${new Date(t.nextFire!).toLocaleTimeString()}`}>
                  ⏾ {t.name}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="hint">
        Runs execute when your machine is awake. Keep-awake is armed before scheduled runs when
        plugged in; sleep-caused misses are reported honestly in the inbox.
      </p>
    </div>
  );
}

// ---------- Inbox + report (T-124) ----------
function InboxView(): JSX.Element {
  const [runs, setRuns] = useState<RunRowT[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: RunRowT; report: any } | null>(null);
  const [q, setQ] = useState('');
  const [approvals, setApprovals] = useState<any[]>([]);

  useEffect(() => {
    void api.runs({ limit: 200 }).then(setRuns).catch(() => {});
    void fetch('/approvals', { headers: { authorization: `Bearer ${getToken()}` } })
      .then((r) => r.json())
      .then(setApprovals)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (selected) void api.report(selected).then(setDetail).catch(() => {});
  }, [selected]);

  const visible = q.trim()
    ? runs.filter((r) => {
        const spec = safeJson(r.jobspec_json);
        return (spec.taskName ?? '').toLowerCase().includes(q.toLowerCase());
      })
    : runs;

  return (
    <div className="inbox-layout">
      <div className="inbox-list">
        <input
          className="inbox-search"
          placeholder="Search runs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="inbox-search"
        />
        {approvals.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div className="chip needs-you" style={{ display: 'inline-block', marginBottom: 6 }}>
              NEEDS YOU — {approvals.length} approval{approvals.length > 1 ? 's' : ''}
            </div>
            {approvals.map((a) => {
              const payload = typeof a.payload_json === 'string' ? safeJson(a.payload_json) : a.payload_json;
              return (
                <div key={a.id} className="inbox-row" style={{ border: '1px solid var(--brass)' }}>
                  <strong>Permission request</strong>
                  <div className="meta mono">{String(payload?.tool ?? '').slice(0, 80)}</div>
                </div>
              );
            })}
          </div>
        )}
        {visible.length === 0 && approvals.length === 0 && (
          <div className="empty">No runs yet. Book one from the calendar.</div>
        )}
        {visible.map((r) => {
          const spec = safeJson(r.jobspec_json);
          return (
            <div
              key={r.id}
              className={`inbox-row ${selected === r.id ? 'sel' : ''}`}
              onClick={() => setSelected(r.id)}
              data-testid={`run-${r.state}`}
            >
              <strong>{spec.taskName}</strong>
              <div className="meta">
                <span className={`chip ${chipClass(r.state)}`}>{r.state.replace('_', ' ')}</span>
                <span className="mono">${Number(r.cost_usd ?? 0).toFixed(2)}</span>
                <span>{r.scheduled_for ? new Date(r.scheduled_for).toLocaleString() : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="report">
        {!detail && <div className="empty">Select a run to read its report.</div>}
        {detail && (
          <>
            <h2>{safeJson(detail.run.jobspec_json).taskName}</h2>
            <div className="statrow mono">
              <span className={`chip ${chipClass(detail.run.state)}`}>{detail.run.state}</span>
              {detail.run.outcome_reason && <span>reason: {detail.run.outcome_reason}</span>}
              <span>${Number(detail.run.cost_usd ?? 0).toFixed(4)}</span>
              <span>{detail.run.turns} turns</span>
              {detail.run.started_at && detail.run.ended_at && (
                <span>{Math.round((detail.run.ended_at - detail.run.started_at) / 1000)}s</span>
              )}
              {detail.run.branch && <span className="mono">{detail.run.branch}</span>}
            </div>
            {detail.report?.summary && <div className="summary-block">{detail.report.summary}</div>}
            {detail.report?.diffStat?.length > 0 && (
              <table className="diffstat-table mono">
                <tbody>
                  {detail.report.diffStat.map((s: any) => (
                    <tr key={s.path}>
                      <td>{s.path}</td>
                      <td className="add">+{s.additions}</td>
                      <td className="del">−{s.deletions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {detail.report?.ranLateMs > 0 && (
              <p className="hint">⏰ Ran {Math.round(detail.report.ranLateMs / 60000)}m late (machine slept).</p>
            )}
            {detail.report?.coveredOccurrences?.length > 0 && (
              <p className="hint">
                Covers {detail.report.coveredOccurrences.length} missed occurrence(s).
              </p>
            )}
            {detail.run.branch && detail.run.state === 'completed' && (
              <p className="ok-banner mono">Branch ready for review: {detail.run.branch}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function chipClass(state: string): string {
  if (['completed'].includes(state)) return 'completed';
  if (['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state)) return 'failed';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'running';
  if (state === 'waiting_approval' || state === 'awaiting_user') return 'needs-you';
  return '';
}

// ---------- Tasks (FR-5/FR-6 management surface) ----------
function TasksView(): JSX.Element {
  const [tasks, setTasks] = useState<TaskViewT[]>([]);
  const [queue, setQueue] = useState<Array<{ runId: string; name: string; position: number; reason: string }>>([]);
  const load = (): void => {
    void api.tasks().then(setTasks).catch(() => {});
    void api.queue().then(setQueue).catch(() => {});
  };
  useEffect(load, []);
  return (
    <div style={{ maxWidth: 760 }}>
      {queue.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <h3 style={{ margin: '0 0 8px' }}>Queue</h3>
          {queue.map((q) => (
            <div key={q.runId} className="tasklist-row" data-testid={`queue-${q.position}`}>
              <span className="chip running">#{q.position}</span>
              <div className="grow">
                <strong>{q.name}</strong>
                <div className="hint" style={{ margin: 0 }}>{q.reason}</div>
              </div>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.cancelRun(q.runId);
                  load();
                }}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
      <h3 style={{ margin: '0 0 8px' }}>Tasks</h3>
      {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
      {tasks.map((t) => (
        <div key={t.id} className="tasklist-row">
          <div className="grow">
            <strong>{t.name}</strong>
            <div className="meta" style={{ color: 'var(--ink-dim)', fontSize: 12 }}>
              {t.enabled ? `next ${t.nextFire ? new Date(t.nextFire).toLocaleString() : '—'}` : 'disabled'}
              {' · '}${t.budget.maxUsd} · {t.permissionMode}
              {t.repoPath ? ` · ${t.repoPath}` : ''}
            </div>
          </div>
          <button
            className="btn primary"
            onClick={async () => {
              await api.runNow(t.id);
              load();
            }}
          >
            Run now
          </button>
          <button
            className="btn"
            onClick={async () => {
              await api.patchTask(t.id, { enabled: !t.enabled, version: t.version });
              load();
            }}
          >
            {t.enabled ? 'Pause' : 'Enable'}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Composer (T-123) ----------
function Composer({ onDone }: { onDone: () => void }): JSX.Element {
  const [profiles, setProfiles] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [form, setForm] = useState({
    name: '',
    prompt: '',
    repoPath: '',
    profileId: '',
    permissionMode: 'acceptEdits',
    maxUsd: 2,
    maxTurns: 50,
    timeoutSec: 3600,
    kind: 'once' as 'once' | 'rrule',
    runAtLocal: defaultSlot(),
    rruleFreq: 'WEEKLY',
    rruleByDay: 'MO',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.profiles().then(setProfiles).catch(() => {});
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const schedule =
        form.kind === 'once'
          ? { kind: 'once', runAt: new Date(form.runAtLocal).getTime(), tz: form.tz }
          : form.rruleFreq === 'WEEKLY'
            ? { kind: 'rrule', rrule: `FREQ=WEEKLY;BYDAY=${form.rruleByDay};BYHOUR=9;BYMINUTE=0`, tz: form.tz }
            : { kind: 'rrule', rrule: `FREQ=DAILY;BYHOUR=9;BYMINUTE=0`, tz: form.tz };
      await api.createTask({
        name: form.name || 'Untitled task',
        prompt: form.prompt,
        repoPath: form.repoPath || undefined,
        profileId: form.profileId || undefined,
        permissionMode: form.permissionMode,
        budget: { maxUsd: Number(form.maxUsd), maxTurns: Number(form.maxTurns), timeoutSec: Number(form.timeoutSec) },
        schedule,
      });
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-card">
      <h2 style={{ marginTop: 0 }}>Book a run</h2>
      <label className="f">Task name</label>
      <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label className="f">Prompt — what should the agent do?</label>
      <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} data-testid="prompt" />
      <label className="f">Repository path (empty = scratch task)</label>
      <input type="text" value={form.repoPath} onChange={(e) => setForm({ ...form, repoPath: e.target.value })} placeholder="/Users/you/dev/my-repo" />
      <label className="f">Agent profile</label>
      <select value={form.profileId} onChange={(e) => setForm({ ...form, profileId: e.target.value })}>
        <option value="">Generalist (default)</option>
        {profiles.filter((p) => p.slug !== 'generalist').map((p) => (
          <option key={p.id} value={p.id}>
            @{p.slug}
          </option>
        ))}
      </select>
      <div className="row2">
        <div>
          <label className="f">Permission mode</label>
          <select value={form.permissionMode} onChange={(e) => setForm({ ...form, permissionMode: e.target.value })}>
            <option value="plan">plan (dry-run)</option>
            <option value="acceptEdits">acceptEdits</option>
          </select>
        </div>
        <div>
          <label className="f">Budget (USD soft cap)</label>
          <input type="text" className="mono" value={form.maxUsd} onChange={(e) => setForm({ ...form, maxUsd: Number(e.target.value) })} />
        </div>
      </div>
      <div className="row2">
        <div>
          <label className="f">Schedule</label>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'once' | 'rrule' })}>
            <option value="once">One-off</option>
            <option value="rrule">Recurring</option>
          </select>
        </div>
        {form.kind === 'once' ? (
          <div>
            <label className="f">When</label>
            <input type="datetime-local" className="mono" value={form.runAtLocal} onChange={(e) => setForm({ ...form, runAtLocal: e.target.value })} />
          </div>
        ) : (
          <div>
            <label className="f">Repeat</label>
            <select value={`${form.rruleFreq}:${form.rruleByDay}`} onChange={(e) => {
              const [freq, byDay] = e.target.value.split(':');
              setForm({ ...form, rruleFreq: freq, rruleByDay: byDay });
            }}>
              <option value="DAILY:x">Daily 09:00</option>
              <option value="WEEKLY:MO">Mondays 09:00</option>
              <option value="WEEKLY:WE">Wednesdays 09:00</option>
              <option value="WEEKLY:FR">Fridays 09:00</option>
            </select>
          </div>
        )}
      </div>
      <p className="hint">
        Runs fire when this Mac is awake. For overnight jobs, plug in — Clockwork arms keep-awake and
        reports any sleep-caused misses honestly.
      </p>
      {error && <div className="error-banner" data-testid="composer-error">{error}</div>}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !form.prompt} onClick={() => void submit()}>
          Book it
        </button>
      </div>
    </div>
  );
}

function defaultSlot(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}
const pad = (n: number): string => String(n).padStart(2, '0');

// ---------- Settings (T-125 lite) ----------
function SettingsView(): JSX.Element {
  const [paused, setPaused] = useState(false);
  const [snap, setSnap] = useState<any>(null);
  useEffect(() => {
    void api.snapshot().then(setSnap).catch(() => {});
  }, []);
  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="tasklist-row">
        <div className="grow">
          <strong>Pause all scheduling</strong>
          <div className="hint">Queued and future runs hold until resumed. Active runs finish.</div>
        </div>
        <button
          className="btn danger"
          onClick={async () => {
            const r = paused ? await api.resume() : await api.pauseAll();
            setPaused(r.paused);
          }}
        >
          {paused ? 'Resume' : 'Pause all'}
        </button>
      </div>
      {snap && (
        <div className="statrow mono" style={{ marginTop: 14 }}>
          <span>runs today: {snap.runsToday}</span>
          <span>needs you: {snap.needsYou}</span>
        </div>
      )}
      <p className="hint">
        Execution engine: your own Claude Code via <span className="mono">claude -p</span> on your
        subscription login — no API key required. Runs are OS-sandboxed with write access limited to
        the run's worktree.
      </p>
    </div>
  );
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
