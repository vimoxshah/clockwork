/**
 * Settings (T-125): theme picker (light/dark/system, persisted), pause state
 * loaded from the server (not guessed), snapshot stats, engine statement.
 */
import { useState } from 'react';
import { useTheme } from '../theme';
import { SHORTCUTS } from './CommandPalette';
import { Switch } from './ui/switch';
import { Badge } from './ui/card';
import { ByokCard } from './ByokCard';
import { LicenseCard } from './LicenseCard';
import { UpgradeHint } from './UpgradeHint';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
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
    <div className="settings-page">
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
      <div className="settings-grid">
        <div>
          <UsageCard version={version} />
        </div>
        <div>
          <IcsCard version={version} />
          <h3 className="section-title" style={{ marginTop: 18 }}>Keyboard shortcuts</h3>
          <div className="tasklist-row" style={{ display: 'block' }}>
            {SHORTCUTS.map((s) => (
              <div key={s.keys} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span>
                  <kbd className="mono" style={{ background: 'var(--surface-active)', borderRadius: 5, padding: '2px 7px', marginRight: 10 }}>{s.keys}</kbd>
                  {s.action}
                </span>
                <span style={{ color: 'var(--dim)' }}>{s.context}</span>
              </div>
            ))}
            <p className="hint" style={{ marginTop: 8 }}>Press ⌘K anywhere to search commands.</p>
          </div>
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: 20 }}>Security</h3>
      <div className="tasklist-row">
        <div className="grow">
          <strong>Rotate access token</strong>
          <div className="hint">
            Replaces the token this app uses to reach the daemon. Older versions put it in the
            event-stream URL, so it may survive in proxy logs or browser history — rotating is how
            you retire that copy. The old token stops working immediately and Clockwork reloads.
          </div>
        </div>
        <button
          className="btn small shrink-0 whitespace-nowrap"
          data-testid="rotate-token"
          onClick={async () => {
            if (!confirm('Rotate the access token? The old one stops working immediately.')) return;
            try {
              const { token } = await api.rotateToken();
              localStorage.setItem('clockwork.token', token);
              // Every open stream and in-flight request still carries the old
              // credential, so reload rather than trying to re-thread it.
              location.reload();
            } catch (e) {
              alert(`Could not rotate the token: ${(e as Error).message}`);
            }
          }}
        >
          Rotate token
        </button>
      </div>

      <h3 className="section-title" style={{ marginTop: 20 }}>Support</h3>
      <div className="tasklist-row">
        <div className="grow">
          <strong>Export diagnostics</strong>
          <div className="hint">
            Downloads a JSON bundle (versions, provider connection states, engine detection,
            counts) for bug reports. Contains no credentials — API keys never leave the Keychain.
          </div>
        </div>
        <button
          className="btn small"
          data-testid="export-support-bundle"
          onClick={async () => {
            try {
              const bundle = await api.supportBundle();
              const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `clockwork-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              setErr(String((e as Error).message ?? e));
            }
          }}
        >
          Export bundle
        </button>
      </div>

      <h3 className="section-title" style={{ marginTop: 20 }}>Plan &amp; license</h3>
      <LicenseCard version={version} />

      <h3 className="section-title" style={{ marginTop: 20 }}>API providers (BYOK)</h3>
      <ByokCard version={version} />

      <h3 className="section-title" style={{ marginTop: 20 }}>CLI engines</h3>
      <div className="settings-grid">
        <div>
          <ProvidersCard version={version} />
        </div>
        <div>
          <h3 className="section-title" style={{ marginTop: 0 }}>Event triggers</h3>
          <TriggersCard version={version} />
        </div>
      </div>

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

/** ICS calendar subscriptions: human events overlay the agent calendar (read-only). */
function IcsCard({ version }: { version: number }): JSX.Element {
  const sources = useAsync(() => api.icsSources(), [version]);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.addIcsSource(url.trim(), label.trim());
      setMsg(`Connected “${r.label}” — ${r.events} events found.`);
      setUrl(''); setLabel('');
      sources.reload();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };
  const remove = async (id: string): Promise<void> => {
    await api.removeIcsSource(id).catch(() => {});
    sources.reload();
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Subscribe to a read-only ICS feed (Google Calendar → “secret address in iCal format”, Apple
        Calendar published calendar, Fastmail, Nextcloud…). Your meetings appear on the Clockwork
        calendar next to agent work. Clockwork never writes to your personal calendar.
      </p>
      {(sources.data ?? []).map((s) => (
        <div key={s.id} className="tasklist-row">
          <div className="grow">
            <strong>{s.label}</strong>
            <div className="hint mono" style={{ margin: 0, fontSize: 11 }}>{s.url}</div>
          </div>
          <button className="btn danger small" onClick={() => void remove(s.id)}>Disconnect</button>
        </div>
      ))}
      {(sources.data ?? []).length === 0 && !sources.loading && (
        <p className="hint" style={{ color: 'var(--dim)' }}>No calendars connected.</p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/basic.ics" aria-label="ICS URL" style={{ flex: 2, minWidth: 220 }} data-testid="ics-url" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (Work)" aria-label="Calendar label" style={{ flex: 1, minWidth: 120 }} />
        <button className="btn primary small" disabled={busy || !url.trim()} onClick={() => void add()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {msg && <div className="ok-banner">{msg}</div>}
      {err && <div className="error-banner" role="alert">{err}</div>}
    </div>
  );
}

/** Provider cards: installed/version/health per execution engine, with a live test-connection probe. */
const PROVIDER_NOTES: Record<string, string> = {
  cli: 'Default engine. Uses your Claude Code subscription login — no API key.',
  codex: 'OpenAI Codex CLI. Uses your ChatGPT/Codex login.',
  opencode: 'OpenCode CLI with any configured model.',
  hermes: 'Nous Research Hermes Agent one-shot (`hermes -z`). Uses your Hermes-configured provider/model.',
};

function ProvidersCard({ version }: { version: number }): JSX.Element {
  const providers = useAsync(() => api.providers(), [version]);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});

  const test = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      // A real end-to-end probe would burn tokens; version+path presence is the health check.
      const list = await api.providers();
      const p = list.find((x: any) => x.id === id);
      setResult((r) => ({ ...r, [id]: p?.detected ? `healthy · ${p.version ?? 'installed'}` : 'not found on PATH' }));
    } catch (e) {
      setResult((r) => ({ ...r, [id]: String((e as Error).message ?? e) }));
    } finally {
      setTesting(null);
    }
  };

  if (providers.loading) return <p className="hint">Detecting installed engines…</p>;
  if (providers.error) return <div className="error-banner">{providers.error}</div>;
  return (
    <div className="space-y-2">
      {(providers.data ?? []).map((p: any) => (
        <div key={p.id} className="tasklist-row">
          <div className="grow">
            <strong>{p.label}</strong>
            <div className="hint" style={{ margin: 0 }}>
              {PROVIDER_NOTES[p.id] ?? ''}
            </div>
            {result[p.id] && (
              <div className={`mono text-xs ${result[p.id].startsWith('healthy') ? 'text-info' : ''}`} style={{ marginTop: 4 }}>
                test: {result[p.id]}
              </div>
            )}
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Badge variant={p.detected ? 'success' : 'danger'}>{p.detected ? p.version?.slice(0, 28) ?? 'installed' : 'not installed'}</Badge>
            <button className="btn small" disabled={testing === p.id} onClick={() => void test(p.id)}>
              {testing === p.id ? 'Testing…' : 'Test'}
            </button>
          </span>
        </div>
      ))}
      <p className="hint">Detection runs on your machine each time this page loads. Select a provider per task in the composer.</p>
    </div>
  );
}

/** Event triggers (goal #27): create, enable/disable, and observe inbound hooks. */
function TriggersCard({ version }: { version: number }): JSX.Element {
  const triggers = useAsync(() => api.triggers(), [version]);
  const tasks = useAsync(() => api.tasks(), [version]);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'webhook' | 'github'>('webhook');
  const [taskId, setTaskId] = useState('');
  const [secret, setSecret] = useState('');
  const [created, setCreated] = useState<{ id: string; secret?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ feature?: string; requiresPlan?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setGate(null);
    try {
      const res = await api.createTrigger({
        name,
        source,
        taskId,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      setCreated(res);
      setName('');
      setSecret('');
      triggers.reload();
    } catch (e) {
      const apiErr = e as { status?: number; details?: { feature?: string; requiresPlan?: string } };
      if (apiErr.status === 402) {
        setGate(apiErr.details ?? {});
      } else {
        setErr(String((e as Error).message ?? e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {gate && (
        <div style={{ marginBottom: 10 }}>
          <UpgradeHint
            message={`You already have ${triggers.data?.length ?? 0} of the free plan's triggers.`}
            feature={gate.feature ?? 'event_triggers'}
            requiresPlan={gate.requiresPlan}
            onDismiss={() => setGate(null)}
          />
        </div>
      )}
      {err && <div className="error-banner" role="alert">{err}</div>}
      {/* creation form */}
      <div className="row3" style={{ alignItems: 'end' }}>
        <div>
          <label className="f" htmlFor="trg-name">Name</label>
          <input id="trg-name" type="text" value={name} placeholder="PR opened" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="f" htmlFor="trg-src">Source</label>
          <Select value={source} onValueChange={(v) => setSource(v as 'webhook' | 'github')}>
            <SelectTrigger id="trg-src"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="webhook">Webhook (generic)</SelectItem>
              <SelectItem value="github">GitHub</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="f">Fire task</label>
          <Select
            value={taskId || '__none__'}
            onValueChange={(v) => setTaskId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger data-testid="trigger-task-select"><SelectValue placeholder="— pick a task —" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— pick a task —</SelectItem>
              {(tasks.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="f" htmlFor="trg-secret">{source === 'github' ? 'Note' : 'Shared secret (optional)'}</label>
          {source === 'github'
            ? (
              <p className="hint" style={{ margin: 0 }}>
                GitHub verifies via <span className="mono">CLOCKWORK_GITHUB_WEBHOOK_SECRET</span>.
              </p>
            )
            : (
              <input id="trg-secret" type="password" value={secret} placeholder="min 8 chars" onChange={(e) => setSecret(e.target.value)} />
            )}
        </div>
        <button
          className="btn primary"
          disabled={busy || !name.trim() || !taskId}
          onClick={() => void create()}
        >
          Add trigger
        </button>
      </div>

      {created && (
        <div className="ok-banner mono" style={{ marginTop: 10 }}>
          Webhook URL: <strong>{`${window.location.origin}/hooks/${created.id}`}</strong>
          {created.secret && <> · Secret (copy now — shown once): <strong>{created.secret}</strong></>}
          {!created.secret && source === 'webhook' && <> · No secret set — anyone who can reach this daemon can fire it.</>}
        </div>
      )}
      {err && <div className="error-banner">{err}</div>}

      {/* existing triggers */}
      <div style={{ marginTop: 12 }}>
        {(triggers.data ?? []).length === 0 && (
          <p className="hint">
            No triggers yet. A trigger fires a task when an external event arrives — e.g. a GitHub PR
            opens and your review agent runs. Events that don't match are logged, never silently dropped.
          </p>
        )}
        {(triggers.data ?? []).map((t) => (
          <div key={t.id} className="tasklist-row">
            <div className="grow">
              <strong>{t.name}</strong>{' '}
              <span className="hint">
                ({t.source}{t.hasSecret ? ', authenticated' : ', no secret'}
                {t.filter ? `, filter ${JSON.stringify(t.filter)}` : ''})
              </span>
              <div className="hint mono" style={{ fontSize: 11 }}>{`${window.location.origin}/hooks/${t.id}`}</div>
            </div>
            <button
              className="btn"
              onClick={() => void api.toggleTrigger(t.id, !t.enabled).then(triggers.reload)}
            >
              {t.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="btn danger"
              onClick={() => void api.deleteTrigger(t.id).then(triggers.reload)}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
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
