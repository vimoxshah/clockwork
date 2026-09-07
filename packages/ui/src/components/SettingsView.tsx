/**
 * Settings (T-125): theme picker (light/dark/system, persisted), pause state
 * loaded from the server (not guessed), snapshot stats, engine statement.
 */
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme';
import { SHORTCUTS } from './CommandPalette';
import { Switch } from './ui/switch';
import { Badge } from './ui/card';
import { ByokCard } from './ByokCard';
import { LicenseCard } from './LicenseCard';
import { UpgradeHint } from './UpgradeHint';
import { OfficeHoursCard } from './OfficeHoursCard';
import { AutonomyCard } from './AutonomyCard';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { FolderBrowserDialog } from './FolderBrowserDialog';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * The capabilities THIS FILE mounts, declared next to the mounts themselves so
 * the plan matrix in LicenseCard can stop ticking features that have no screen
 * (see featureSurfaces.ts for why this is not one central list). Office hours
 * and earned autonomy register inside their own card files; these four have no
 * file of their own to register from — ProvidersCard and TriggersCard live at
 * the bottom of this one, and ByokCard is mounted here.
 */
registerFeatureSurface({ key: 'byok_providers', tab: 'settings', where: 'Settings › API providers (BYOK)', anchorId: 'byok-providers' });
// The BYOK connect flow is where a custom OpenAI-compatible base URL is
// entered (ProviderConnectFlow, kind `custom_openai`), so it is the same screen.
registerFeatureSurface({ key: 'custom_endpoints', tab: 'settings', where: 'Settings › API providers (BYOK)', anchorId: 'byok-providers' });
registerFeatureSurface({ key: 'cli_engines', tab: 'settings', where: 'Settings › CLI engines', anchorId: 'cli-engines' });
registerFeatureSurface({ key: 'event_triggers', tab: 'settings', where: 'Settings › Event triggers', anchorId: 'event-triggers' });

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

      <h3 className="section-title" style={{ marginTop: 20 }}>Notifications &amp; delivery</h3>
      <DeliveryCard version={version} />

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
        <div className="tasklist-row" data-testid="scheduling-snapshot">
          <div className="grow statrow mono" style={{ margin: 0 }}>
            <span>runs today: {snap.data.runsToday}</span>
            <span>needs you: {snap.data.needsYou}</span>
            {snap.data.nextRun?.name && (
              <span>next: {snap.data.nextRun.name}</span>
            )}
          </div>
        </div>
      )}

      <h3 className="section-title" style={{ marginTop: 20 }} id="office-hours">Office hours</h3>
      <OfficeHoursCard version={version} />

      <h3 className="section-title" style={{ marginTop: 20 }} id="earned-autonomy">Earned autonomy</h3>
      <AutonomyCard version={version} />

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

      <h3 className="section-title" style={{ marginTop: 20 }} id="byok-providers">API providers (BYOK)</h3>
      <ByokCard version={version} />

      <h3 className="section-title" style={{ marginTop: 20 }} id="cli-engines">CLI engines</h3>
      <div className="settings-grid">
        <div>
          <ProvidersCard version={version} />
        </div>
        <div>
          <h3 className="section-title" style={{ marginTop: 0 }} id="event-triggers">Event triggers</h3>
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

// Visually hides the real <input type="file"> while keeping it in the DOM
// (not display:none) so it stays in the tab order and keeps its accessible
// name from the wrapping <label> — a bare icon button would announce nothing.
const hiddenFileInputStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function fmtImportedAt(ts: number | null): string {
  if (!ts) return 'unknown time';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Read a File's text via FileReader (spec: "read it with FileReader and POST the text") — not Blob.text(), so this also works in the older WebViews some builds still target. */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('could not read the selected file'));
    reader.readAsText(file);
  });
}

/**
 * ICS calendar sources: human events overlay the agent calendar (read-only).
 * A source is either a live subscription (url — re-fetched every load) or an
 * imported file (a frozen snapshot, re-parsed only on demand). The two must
 * never look the same in this list (contract, INTENT §4).
 */
function IcsCard({ version }: { version: number }): JSX.Element {
  const sources = useAsync(() => api.icsSources(), [version]);

  // --- subscribe by URL (unchanged) ---
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

  // --- import a file (upload or browse) ---
  const [importLabel, setImportLabel] = useState('');
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [fileInputFocused, setFileInputFocused] = useState(false);

  const importFile = async (file: File): Promise<void> => {
    setPendingFilename(file.name);
    setFileBusy(true); setFileErr(null); setFileMsg(null);
    try {
      const content = await readFileAsText(file);
      const r = await api.importIcsContent({
        content,
        filename: file.name,
        ...(importLabel.trim() ? { label: importLabel.trim() } : {}),
      });
      setFileMsg(`Imported “${r.label}” — ${r.eventCount} events, snapshot at ${fmtImportedAt(r.importedAt)}.`);
      setImportLabel(''); setPendingFilename(null);
      sources.reload();
    } catch (e) {
      setFileErr(String((e as Error).message ?? e));
    } finally { setFileBusy(false); }
  };

  const importPath = async (path: string): Promise<void> => {
    setPendingFilename(path.split('/').pop() ?? path);
    setFileBusy(true); setFileErr(null); setFileMsg(null);
    try {
      const r = await api.importIcsPath({
        path,
        ...(importLabel.trim() ? { label: importLabel.trim() } : {}),
      });
      setFileMsg(`Imported “${r.label}” — ${r.eventCount} events, snapshot at ${fmtImportedAt(r.importedAt)}.`);
      setImportLabel(''); setPendingFilename(null);
      sources.reload();
    } catch (e) {
      setFileErr(String((e as Error).message ?? e));
    } finally { setFileBusy(false); }
  };

  // --- re-import (file sources only): per-row busy/error, keyed by source id ---
  const [reimportBusy, setReimportBusy] = useState<Record<string, boolean>>({});
  const [reimportErr, setReimportErr] = useState<Record<string, string | null>>({});

  const reimport = async (id: string): Promise<void> => {
    setReimportBusy((b) => ({ ...b, [id]: true }));
    setReimportErr((m) => ({ ...m, [id]: null }));
    try {
      await api.reimportIcs(id);
      sources.reload();
    } catch (e) {
      setReimportErr((m) => ({ ...m, [id]: String((e as Error).message ?? e) }));
    } finally {
      setReimportBusy((b) => ({ ...b, [id]: false }));
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Subscribe to a read-only ICS feed (Google Calendar → “secret address in iCal format”, Apple
        Calendar published calendar, Fastmail, Nextcloud…). Your meetings appear on the Clockwork
        calendar next to agent work. Clockwork never writes to your personal calendar.
      </p>
      <p className="hint">
        A subscribed feed stays up to date on its own; an imported file is a snapshot of the moment
        you imported it, and only changes when you re-import it.
      </p>

      {(sources.data ?? []).map((s) => (
        <div key={s.id} className="tasklist-row" style={{ flexWrap: 'wrap' }}>
          <div className="grow">
            <strong>{s.label}</strong>{' '}
            <Badge variant={s.kind === 'file' ? 'warning' : 'success'}>
              {s.kind === 'file' ? 'Imported snapshot' : 'Subscribed'}
            </Badge>
            {s.kind === 'file' ? (
              <div className="hint" style={{ margin: 0, fontSize: 11 }}>
                Imported {fmtImportedAt(s.importedAt)} · {s.eventCount ?? 0} events
              </div>
            ) : (
              <div className="hint mono" style={{ margin: 0, fontSize: 11 }}>{s.url}</div>
            )}
            {reimportErr[s.id] && (
              <div className="error-banner" role="alert">{reimportErr[s.id]}</div>
            )}
          </div>
          {s.kind === 'file' && (
            <button
              className="btn small"
              disabled={!!reimportBusy[s.id]}
              onClick={() => void reimport(s.id)}
            >
              {reimportBusy[s.id] ? 'Re-importing…' : 'Re-import'}
            </button>
          )}
          <button className="btn danger small" onClick={() => void remove(s.id)}>
            {s.kind === 'file' ? 'Remove' : 'Disconnect'}
          </button>
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

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <strong style={{ fontSize: 13 }}>Or import a file</strong>
        <p className="hint" style={{ marginTop: 4 }}>
          Export a calendar as .ics (or .ical) and bring in a one-time snapshot — nothing is
          fetched from the network, and nothing changes until you re-import.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label
            htmlFor="ics-file-input"
            className="btn small"
            style={{
              cursor: fileBusy ? 'default' : 'pointer',
              outline: fileInputFocused ? '2px solid var(--accent)' : 'none',
              outlineOffset: 2,
            }}
          >
            {fileBusy ? 'Importing…' : 'Choose file…'}
            <input
              id="ics-file-input"
              type="file"
              accept=".ics,.ical"
              disabled={fileBusy}
              style={hiddenFileInputStyle}
              onFocus={() => setFileInputFocused(true)}
              onBlur={() => setFileInputFocused(false)}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </label>
          <button className="btn small" disabled={fileBusy} onClick={() => setBrowsing(true)}>
            Browse…
          </button>
          <input
            value={importLabel}
            onChange={(e) => setImportLabel(e.target.value)}
            placeholder="Label (optional — defaults to the calendar's own name)"
            aria-label="Imported calendar label"
            style={{ flex: 1, minWidth: 160 }}
          />
        </div>
        {fileBusy && pendingFilename && (
          <p className="hint" style={{ margin: '4px 0 0' }}>Reading “{pendingFilename}”…</p>
        )}
        {fileMsg && <div className="ok-banner">{fileMsg}</div>}
        {fileErr && <div className="error-banner" role="alert">{fileErr}</div>}
      </div>

      {browsing && (
        <FolderBrowserDialog
          open={browsing}
          files={['ics', 'ical']}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            setBrowsing(false);
            void importPath(p);
          }}
        />
      )}
    </div>
  );
}

/**
 * Delivery credentials for every channel the daemon can actually reach:
 * Telegram (chat-based approvals), the generic HMAC webhook, a Slack incoming
 * webhook and an SMTP relay.
 *
 * All four are bearer credentials — a bot token acts as the whole bot, a Slack
 * incoming-webhook URL posts to that channel for anyone who holds it, and an
 * SMTP URL carries the mailbox password — so none of them is ever rendered in
 * full once saved. The daemon returns only the masked form
 * (`readDeliveryConfigStatus`), and the inputs here are write-only.
 *
 * One asymmetry is stated on screen rather than hidden: Telegram is the only
 * channel that receives the APPROVAL REQUEST itself, because the approval
 * fan-out in the daemon's run-manager still keeps its own telegram/webhook
 * copy. Slack and email receive run REPORTS. Naming that here is cheaper than
 * a user discovering it while a run waits.
 *
 * Exported only so `packages/ui/test/delivery-channels-ui.test.tsx` can drive
 * this card on its own — mounting the whole Settings page to click one Save
 * button would route a dozen unrelated fetches. Same reason `App.tsx` exports
 * `VersionSkewNotice`. `SettingsView` below is still its only mount site.
 */
export function DeliveryCard({ version }: { version: number }): JSX.Element {
  const cfg = useAsync(() => api.deliveryConfig(), [version]);
  const [token, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [tokenErr, setTokenErr] = useState<string | null>(null);

  const [webhookSecret, setWebhookSecret] = useState('');
  const [whBusy, setWhBusy] = useState(false);
  const [whMsg, setWhMsg] = useState<string | null>(null);
  const [whErr, setWhErr] = useState<string | null>(null);

  const [chatId, setChatId] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);

  const [slackUrl, setSlackUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackMsg, setSlackMsg] = useState<string | null>(null);
  const [slackOk, setSlackOk] = useState<boolean | null>(null);

  const [smtpUrl, setSmtpUrl] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpTo, setSmtpTo] = useState('');
  const [smtpBusy, setSmtpBusy] = useState(false);
  const [smtpMsg, setSmtpMsg] = useState<string | null>(null);
  const [smtpOk, setSmtpOk] = useState<boolean | null>(null);

  const configured = cfg.data?.telegram.configured ?? false;
  const slackConfigured = cfg.data?.slack?.configured ?? false;
  const smtpConfigured = cfg.data?.smtp?.configured ?? false;

  const saveToken = async (): Promise<void> => {
    setTokenBusy(true); setTokenErr(null); setTokenMsg(null);
    try {
      await api.saveDeliveryConfig({ telegramBotToken: token.trim() });
      setTokenInput('');
      setTokenMsg('Bot token saved.');
      cfg.reload();
    } catch (e) {
      setTokenErr(String((e as Error).message ?? e));
    } finally {
      setTokenBusy(false);
    }
  };

  const clearToken = async (): Promise<void> => {
    if (!confirm('Clear the Telegram bot token? Chat approvals stop reaching Telegram until a new token is set.')) return;
    setTokenBusy(true); setTokenErr(null); setTokenMsg(null);
    try {
      await api.saveDeliveryConfig({ telegramBotToken: null });
      setTokenMsg('Bot token cleared.');
      cfg.reload();
    } catch (e) {
      setTokenErr(String((e as Error).message ?? e));
    } finally {
      setTokenBusy(false);
    }
  };

  const saveWebhookSecret = async (): Promise<void> => {
    setWhBusy(true); setWhErr(null); setWhMsg(null);
    try {
      await api.saveDeliveryConfig({ webhookSecret: webhookSecret.trim() });
      setWebhookSecret('');
      setWhMsg('Webhook secret saved.');
      cfg.reload();
    } catch (e) {
      setWhErr(String((e as Error).message ?? e));
    } finally {
      setWhBusy(false);
    }
  };

  const clearWebhookSecret = async (): Promise<void> => {
    if (!confirm('Clear the webhook secret? Outgoing webhook deliveries stop being signed until a new one is set.')) return;
    setWhBusy(true); setWhErr(null); setWhMsg(null);
    try {
      await api.saveDeliveryConfig({ webhookSecret: null });
      setWhMsg('Webhook secret cleared.');
      cfg.reload();
    } catch (e) {
      setWhErr(String((e as Error).message ?? e));
    } finally {
      setWhBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setTestBusy(true); setTestMsg(null); setTestOk(null);
    try {
      const r = await api.testTelegram(chatId.trim());
      setTestOk(r.ok);
      setTestMsg(r.ok ? 'Delivered — check the chat.' : (r.error ?? 'Telegram did not accept the message.'));
    } catch (e) {
      setTestOk(false);
      setTestMsg(String((e as Error).message ?? e));
    } finally {
      setTestBusy(false);
    }
  };

  const saveSlack = async (): Promise<void> => {
    setSlackBusy(true); setSlackMsg(null); setSlackOk(null);
    try {
      await api.saveDeliveryConfig({ slackWebhookUrl: slackUrl.trim() });
      setSlackUrl('');
      setSlackOk(true);
      setSlackMsg('Slack webhook saved.');
      cfg.reload();
    } catch (e) {
      setSlackOk(false);
      setSlackMsg(String((e as Error).message ?? e));
    } finally {
      setSlackBusy(false);
    }
  };

  const clearSlack = async (): Promise<void> => {
    if (!confirm('Clear the Slack webhook? Run reports stop reaching Slack until a new one is set.')) return;
    setSlackBusy(true); setSlackMsg(null); setSlackOk(null);
    try {
      await api.saveDeliveryConfig({ slackWebhookUrl: null });
      setSlackOk(true);
      setSlackMsg('Slack webhook cleared.');
      cfg.reload();
    } catch (e) {
      setSlackOk(false);
      setSlackMsg(String((e as Error).message ?? e));
    } finally {
      setSlackBusy(false);
    }
  };

  const testSlack = async (): Promise<void> => {
    setSlackBusy(true); setSlackMsg(null); setSlackOk(null);
    try {
      const r = await api.testSlack();
      setSlackOk(r.ok);
      // r.error is Slack's own body text, forwarded by the daemon.
      setSlackMsg(r.ok ? 'Sent — check the Slack channel.' : (r.error ?? 'Slack did not accept the message.'));
    } catch (e) {
      setSlackOk(false);
      setSlackMsg(String((e as Error).message ?? e));
    } finally {
      setSlackBusy(false);
    }
  };

  const saveSmtp = async (): Promise<void> => {
    setSmtpBusy(true); setSmtpMsg(null); setSmtpOk(null);
    try {
      // Only what was typed is sent, one key per field. Two reasons, and both
      // are bugs if you skip them: sending `smtpFrom: null` on every URL save
      // would silently drop an already-stored From address (Clear is the
      // explicit path for that), and sending `smtpUrl: ''` to change only the
      // From address would take the relay down with it.
      const url = smtpUrl.trim();
      const from = smtpFrom.trim();
      await api.saveDeliveryConfig({ ...(url ? { smtpUrl: url } : {}), ...(from ? { smtpFrom: from } : {}) });
      setSmtpUrl('');
      setSmtpFrom('');
      setSmtpOk(true);
      setSmtpMsg(url ? 'SMTP relay saved.' : 'From address saved.');
      cfg.reload();
    } catch (e) {
      setSmtpOk(false);
      setSmtpMsg(String((e as Error).message ?? e));
    } finally {
      setSmtpBusy(false);
    }
  };

  const clearSmtp = async (): Promise<void> => {
    if (!confirm('Clear the SMTP relay? Email reports stop being sent until a new relay is set.')) return;
    setSmtpBusy(true); setSmtpMsg(null); setSmtpOk(null);
    try {
      await api.saveDeliveryConfig({ smtpUrl: null, smtpFrom: null });
      setSmtpFrom('');
      setSmtpOk(true);
      setSmtpMsg('SMTP relay cleared.');
      cfg.reload();
    } catch (e) {
      setSmtpOk(false);
      setSmtpMsg(String((e as Error).message ?? e));
    } finally {
      setSmtpBusy(false);
    }
  };

  const testSmtp = async (): Promise<void> => {
    setSmtpBusy(true); setSmtpMsg(null); setSmtpOk(null);
    try {
      const r = await api.testSmtp(smtpTo.trim());
      setSmtpOk(r.ok);
      // r.error is the relay's own reply line, forwarded by the daemon.
      setSmtpMsg(r.ok ? 'Sent — check the inbox.' : (r.error ?? 'The relay refused the message.'));
    } catch (e) {
      setSmtpOk(false);
      setSmtpMsg(String((e as Error).message ?? e));
    } finally {
      setSmtpBusy(false);
    }
  };

  if (cfg.loading) return <p className="hint">Loading delivery settings…</p>;
  if (cfg.error) return <div className="error-banner">{cfg.error}</div>;

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        When a run waits for your OK, Clockwork can message you on Telegram instead of waiting for you
        to open the app — you approve or deny right from the chat. The bot token is a credential:
        anyone who holds it can act as your bot, so treat it like a password.
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        Slack and email carry the <strong>run report</strong> — what the agent did, what it cost, and
        the branch it left behind. They do not carry the approval request itself: an approval still
        reaches you through Telegram, the webhook, or this app. Every credential below is stored on
        this Mac at file mode 0600 and is never handed to a running agent.
      </p>

      <div className="tasklist-row">
        <div className="grow">
          <label className="f" htmlFor="tg-token">Telegram bot token</label>
          <input
            id="tg-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={configured ? (cfg.data?.telegram.botTokenMasked ?? 'configured') : 'Paste the token from @BotFather'}
            style={{ width: '100%' }}
            data-testid="telegram-token-input"
          />
          <div className="hint" style={{ margin: '4px 0 0' }}>
            {configured
              ? `Configured — ${cfg.data?.telegram.botTokenMasked}`
              : 'Not configured — chat approvals are unavailable until a bot token is set.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn small primary"
            disabled={tokenBusy || !token.trim()}
            onClick={() => void saveToken()}
            data-testid="telegram-token-save"
          >
            {tokenBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small danger"
            disabled={tokenBusy || !configured}
            onClick={() => void clearToken()}
          >
            Clear
          </button>
        </div>
      </div>
      {tokenMsg && <div className="ok-banner">{tokenMsg}</div>}
      {tokenErr && <div className="error-banner" role="alert">{tokenErr}</div>}

      <div className="tasklist-row" style={{ marginTop: 8 }}>
        <div className="grow">
          <label className="f" htmlFor="tg-test-chat">Send test message</label>
          <input
            id="tg-test-chat"
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Chat id"
            disabled={!configured}
            data-testid="telegram-test-chatid"
          />
        </div>
        <button
          className="btn small"
          disabled={!configured || testBusy || !chatId.trim()}
          onClick={() => void sendTest()}
          data-testid="telegram-test-send"
        >
          {testBusy ? 'Sending…' : 'Send test message'}
        </button>
      </div>
      {testMsg && (
        <div className={testOk ? 'ok-banner' : 'error-banner'} role={testOk ? undefined : 'alert'}>
          {testMsg}
        </div>
      )}

      <div className="tasklist-row" style={{ marginTop: 14 }}>
        <div className="grow">
          <label className="f" htmlFor="wh-secret">Webhook secret (optional)</label>
          <input
            id="wh-secret"
            type="password"
            autoComplete="off"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={cfg.data?.webhook.configured ? 'configured' : 'Shared secret used to sign outgoing webhook calls'}
            style={{ width: '100%' }}
          />
          <div className="hint" style={{ margin: '4px 0 0' }}>
            {cfg.data?.webhook.configured ? 'Configured.' : 'Not set — outgoing webhooks are sent unsigned.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small primary" disabled={whBusy || !webhookSecret.trim()} onClick={() => void saveWebhookSecret()}>
            {whBusy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn small danger" disabled={whBusy || !cfg.data?.webhook.configured} onClick={() => void clearWebhookSecret()}>
            Clear
          </button>
        </div>
      </div>
      {whMsg && <div className="ok-banner">{whMsg}</div>}
      {whErr && <div className="error-banner" role="alert">{whErr}</div>}

      <div className="tasklist-row" style={{ marginTop: 14 }}>
        <div className="grow">
          <label className="f" htmlFor="slack-hook">Slack incoming webhook</label>
          <input
            id="slack-hook"
            type="password"
            autoComplete="off"
            value={slackUrl}
            onChange={(e) => setSlackUrl(e.target.value)}
            placeholder={slackConfigured ? (cfg.data?.slack?.webhookUrlMasked ?? 'configured') : 'https://hooks.slack.com/services/…'}
            style={{ width: '100%' }}
            data-testid="slack-webhook-input"
          />
          <div className="hint" style={{ margin: '4px 0 0' }}>
            {slackConfigured
              ? `Configured — ${cfg.data?.slack?.webhookUrlMasked}`
              : 'Not configured. The URL is the credential: anyone holding it can post to that channel. One webhook posts to one channel — a second destination needs a second webhook.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn small primary"
            disabled={slackBusy || !slackUrl.trim()}
            onClick={() => void saveSlack()}
            data-testid="slack-webhook-save"
          >
            {slackBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small"
            disabled={slackBusy || !slackConfigured}
            onClick={() => void testSlack()}
            data-testid="slack-test-send"
          >
            Send test
          </button>
          <button
            className="btn small danger"
            disabled={slackBusy || !slackConfigured}
            onClick={() => void clearSlack()}
          >
            Clear
          </button>
        </div>
      </div>
      {slackMsg && (
        <div className={slackOk ? 'ok-banner' : 'error-banner'} role={slackOk ? undefined : 'alert'} data-testid="slack-result">
          {slackMsg}
        </div>
      )}

      <div className="tasklist-row" style={{ marginTop: 14 }}>
        <div className="grow">
          <label className="f" htmlFor="smtp-url">SMTP relay</label>
          <input
            id="smtp-url"
            type="password"
            autoComplete="off"
            value={smtpUrl}
            onChange={(e) => setSmtpUrl(e.target.value)}
            placeholder={smtpConfigured ? (cfg.data?.smtp?.endpointMasked ?? 'configured') : 'smtp://user:pass@smtp.example.com:587'}
            style={{ width: '100%' }}
            data-testid="smtp-url-input"
          />
          <div className="hint" style={{ margin: '4px 0 0' }}>
            {smtpConfigured
              ? `Configured — ${cfg.data?.smtp?.endpointMasked}`
              : 'Not configured. Port 587 upgrades with STARTTLS; smtps:// is TLS from the first byte. Plain-text mail only — no attachments, no HTML.'}
          </div>
          <label className="f" htmlFor="smtp-from" style={{ marginTop: 8 }}>From address</label>
          <input
            id="smtp-from"
            type="email"
            autoComplete="off"
            value={smtpFrom}
            onChange={(e) => setSmtpFrom(e.target.value)}
            placeholder={cfg.data?.smtp?.from ?? 'clockwork@example.com (defaults to the SMTP username)'}
            style={{ width: '100%' }}
            data-testid="smtp-from-input"
          />
          <div className="hint" style={{ margin: '4px 0 0' }}>
            {cfg.data?.smtp?.from
              ? `Sending as ${cfg.data.smtp?.from}. Leave blank to keep it.`
              : 'Optional — leave blank when the SMTP username is itself an email address.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn small primary"
            disabled={smtpBusy || (!smtpUrl.trim() && !smtpFrom.trim())}
            onClick={() => void saveSmtp()}
            data-testid="smtp-save"
          >
            {smtpBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small danger"
            disabled={smtpBusy || !smtpConfigured}
            onClick={() => void clearSmtp()}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="tasklist-row">
        <div className="grow">
          <label className="f" htmlFor="smtp-test-to">Send test email to</label>
          <input
            id="smtp-test-to"
            type="email"
            value={smtpTo}
            onChange={(e) => setSmtpTo(e.target.value)}
            placeholder="you@example.com"
            disabled={!smtpConfigured}
            data-testid="smtp-test-to"
          />
        </div>
        <button
          className="btn small"
          disabled={!smtpConfigured || smtpBusy || !smtpTo.trim()}
          onClick={() => void testSmtp()}
          data-testid="smtp-test-send"
        >
          {smtpBusy ? 'Sending…' : 'Send test email'}
        </button>
      </div>
      {smtpMsg && (
        <div className={smtpOk ? 'ok-banner' : 'error-banner'} role={smtpOk ? undefined : 'alert'} data-testid="smtp-result">
          {smtpMsg}
        </div>
      )}
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
              onClick={() => void api.deleteTrigger(t.id).catch(() => {}).then(triggers.reload)}
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
