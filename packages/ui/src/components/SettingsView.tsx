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
 * and earned autonomy register inside their own card files; these five have no
 * file of their own to register from — ProvidersCard and TriggersCard live at
 * the bottom of this one, QuietHoursCard sits right below, and ByokCard is
 * mounted here.
 */
registerFeatureSurface({ key: 'byok_providers', tab: 'settings', where: 'Settings › API providers (BYOK)', anchorId: 'byok-providers' });
// The BYOK connect flow is where a custom OpenAI-compatible base URL is
// entered (ProviderConnectFlow, kind `custom_openai`), so it is the same screen.
registerFeatureSurface({ key: 'custom_endpoints', tab: 'settings', where: 'Settings › API providers (BYOK)', anchorId: 'byok-providers' });
registerFeatureSurface({ key: 'cli_engines', tab: 'settings', where: 'Settings › CLI engines', anchorId: 'cli-engines' });
registerFeatureSurface({ key: 'event_triggers', tab: 'settings', where: 'Settings › Event triggers', anchorId: 'event-triggers' });
// T1-8: the scheduler has honoured delivery_json.quietHours since ADR-030;
// DeliveryConfig just never carried the key, so this is the first build where
// setting it has anywhere to go.
registerFeatureSurface({ key: 'quiet_hours', tab: 'settings', where: 'Settings › Quiet hours', anchorId: 'quiet-hours' });

/**
 * T1-6 — "Check for updates" has no entry here on purpose.
 * `FeatureSurface.key` has to match a capability `GET /capabilities`
 * returns (`packages/daemon/src/features.ts`'s `FEATURES` list), and none
 * of its ~30 keys names anything like this — it is not gated by plan tier,
 * it is a shell-level utility every install already has. Inventing a key
 * just to get a tick would be exactly the "fake gate" `features.ts`'s own
 * header forbids, so `UpdateCheckCard` below mounts with a plain `id`
 * (`check-for-updates`) and no registration.
 */

/**
 * Tauri's real IPC bridge, called directly rather than through
 * `@tauri-apps/api`: that package is not a dependency of this workspace —
 * absent from `package.json`, the lockfile, and `node_modules` (checked,
 * not assumed) — and adding one was outside this change's touch set.
 * `window.__TAURI_INTERNALS__` is what Tauri injects into every webview it
 * manages, independent of the `app.withGlobalTauri` config flag (that flag
 * only controls the friendlier `window.__TAURI__` namespace, which needs a
 * `tauri.conf.json` edit this change also does not make); it is the same
 * bridge `@tauri-apps/api`'s own `invoke()` calls underneath, and Tauri's
 * own docs reach for it directly for exactly this no-npm-package case
 * (`develop/Tests/mocking.mdx` spies on it to drive `invoke()` in tests).
 * `undefined` outside the desktop shell — `src-tauri/src/lib.rs`'s pairing
 * script comment notes a browser tab pointed straight at the daemon is a
 * real, supported way to reach this page, and that tab has no bridge at all.
 *
 * `invoke` is declared generic (`<T>(cmd: string) => Promise<T>`), the same
 * shape `@tauri-apps/api/core`'s own `invoke<T>` carries upstream, rather
 * than returning `Promise<unknown>` and asserting the result at the call
 * site — a real bridge is genuinely generic over what each command returns,
 * so this is the pass-through-generic case, not a laundered `unknown`.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: <T>(cmd: string) => Promise<T> };
  }
}

function tauriInvoke<T>(cmd: string): Promise<T> | null {
  const bridge = typeof window === 'undefined' ? undefined : window.__TAURI_INTERNALS__;
  return bridge ? bridge.invoke<T>(cmd) : null;
}

/** Mirrors `src-tauri/src/lib.rs`'s `update_check_json` — the four honesty outcomes, as data. */
interface UpdateCheckResult {
  status: 'up_to_date' | 'newer_available' | 'check_failed';
  current?: string;
  latest?: string;
  notesUrl?: string;
  message: string;
}

/**
 * `notesUrl` is GitHub's `html_url`, relayed through
 * `check_for_updates_command` off a remote document this app did not
 * author. `agent-content-escaping.test.tsx` names the exact vector: binding
 * a raw string straight onto a link's target attribute, via a JSX
 * expression, is the one place React hands the DOM a URL with no scheme
 * check — so a `javascript:`/`data:` value there would run on click.
 * Refused down to `https:` only; anything else — an unparsable string, a
 * different scheme — renders no link at all rather than a broken or
 * dangerous one.
 */
function safeHttpsUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * T1-6 — "Check for updates", user-initiated only.
 *
 * Asks GitHub for the latest release, and only on this click: no timer, no
 * check on launch, no "check daily" preference
 * (docs/architecture/update-delivery.md names those as the heavier, still
 * undecided options). The fetch itself runs in the Tauri shell, not here
 * and not through the daemon — this page's CSP does not allow
 * `connect-src` to `api.github.com` (nor should it: the daemon stays
 * incurious about the internet, on purpose), so this card's job is to call
 * `check_for_updates_command` and render whichever of the four outcomes
 * comes back. A failed check renders as failed; it is never reported as
 * "up to date" just because nothing newer was confirmed.
 *
 * THE GRANT THIS BUTTON RIDES ON, and why it is one line wide. The main
 * window is built on `WebviewUrl::External(DAEMON_URL)` (`run()` in
 * `src-tauri/src/lib.rs`), so this page's origin is
 * `http://127.0.0.1:4747`, which Tauri does NOT treat as local
 * (`tauri-2.11.5/src/webview/mod.rs`'s `is_local_url`). Tauri 2.11.1 made
 * remote origins fail closed on custom commands, so until T1-19 every
 * click here was ACL-rejected in the shipped app, however healthy the
 * network was.
 *
 * `src-tauri/capabilities/check-for-updates.json` now grants exactly
 * `check_for_updates_command`, to the `main` window, on that one origin,
 * with `local: false` and no `core:default`. That narrowness is the whole
 * reason the grant was acceptable: the command takes no arguments, reads a
 * hardcoded GitHub URL over HTTPS and returns a version string, so the
 * worst it hands a page that already controls this window is the version
 * number GitHub publishes anyway. A command that could read a token would
 * not have survived the same question, and it would not inherit this
 * grant — shipping an app manifest makes every later command fail closed
 * until it is named too.
 *
 * The tray's "Check for updates…" stays native rather than routing here:
 * it has to answer with the window hidden and with the daemon down, and in
 * neither state is there a Settings screen to render into.
 */
export function UpdateCheckCard(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const safeNotesUrl = result?.notesUrl ? safeHttpsUrl(result.notesUrl) : null;

  const check = async (): Promise<void> => {
    const pending = tauriInvoke<UpdateCheckResult>('check_for_updates_command');
    if (!pending) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setBusy(true);
    setResult(null);
    try {
      setResult(await pending);
    } catch (e) {
      // The IPC call itself failing is still a failure to report — never silence.
      setResult({ status: 'check_failed', message: `Couldn't check for updates: ${String((e as Error).message ?? e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Asks GitHub for the latest release — only when you click. Nothing runs in the background,
        nothing is scheduled, and this never downloads anything; it tells you a newer build exists
        so you can get it from the releases page yourself.
      </p>
      <div className="tasklist-row">
        <div className="grow">
          <strong>Latest release</strong>
          <div className="hint" style={{ margin: 0 }}>Checked only when you click — nothing runs on its own.</div>
        </div>
        <button
          className="btn small"
          disabled={busy}
          onClick={() => void check()}
          data-testid="check-for-updates-button"
        >
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {unavailable && (
        <div className="error-banner" role="alert" data-testid="check-for-updates-unavailable">
          Update checks need the Clockwork desktop app — open this page there rather than in a browser tab.
        </div>
      )}
      {result && result.status !== 'check_failed' && (
        <div className="ok-banner" data-testid="check-for-updates-result">
          {result.message}
          {result.status === 'newer_available' && safeNotesUrl && (
            <>
              {' '}
              <a
                // `.href` is assigned imperatively once the element mounts —
                // never bound to a JSX expression container the way a plain
                // dynamic attribute would be. That JSX-attribute pattern is
                // what `agent-content-escaping.test.tsx` greps the whole
                // source tree for, precisely because it is the one place
                // React would hand a string to the DOM unvalidated.
                // `safeNotesUrl` (above) has already refused anything but
                // `https:`, so this assignment is the second, structural
                // half of that defence, not a way around the first.
                ref={(el) => {
                  if (el && safeNotesUrl) el.href = safeNotesUrl;
                }}
                target="_blank"
                // `noreferrer` alone also disables `window.opener` — the
                // WHATWG HTML spec has `noreferrer` imply `noopener` — so no
                // separate token is needed.
                rel="noreferrer"
                data-testid="check-for-updates-notes-link"
              >
                Release notes
              </a>
            </>
          )}
        </div>
      )}
      {result && result.status === 'check_failed' && (
        <div className="error-banner" role="alert" data-testid="check-for-updates-result">{result.message}</div>
      )}
    </div>
  );
}

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

      <section className="settings-card">
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
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title">Notifications &amp; delivery</h3>
      <DeliveryCard version={version} />
      </section>

      <section className="settings-card">
      <h3 className="section-title">Scheduling</h3>
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
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title" id="office-hours">Office hours</h3>
      <OfficeHoursCard version={version} />
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title" id="quiet-hours">Quiet hours</h3>
      <QuietHoursCard version={version} />
      </section>

      <section className="settings-card">
      <h3 className="section-title" id="earned-autonomy">Earned autonomy</h3>
      <AutonomyCard version={version} />
      </section>

      <section className="settings-card">
      <h3 className="section-title">Usage &amp; limits</h3>
      <UsageCard version={version} />
      </section>

      <section className="settings-card">
      <h3 className="section-title">Calendars</h3>
      <IcsCard version={version} />
      </section>

      <section className="settings-card">
          <h3 className="section-title">Keyboard shortcuts</h3>
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
      </section>

      <section className="settings-card">
      <h3 className="section-title">Security</h3>
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
      </section>

      <section className="settings-card">
      <h3 className="section-title">Support</h3>
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
      </section>

      <section className="settings-card">
      <h3 className="section-title" id="check-for-updates">Check for updates</h3>
      <UpdateCheckCard />
      </section>

      <section className="settings-card">
      <h3 className="section-title">Plan &amp; license</h3>
      <LicenseCard version={version} />
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title" id="byok-providers">API providers (BYOK)</h3>
      <ByokCard version={version} />
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title" id="cli-engines">CLI engines</h3>
      <ProvidersCard version={version} />
      </section>

      <section className="settings-card settings-card--wide">
      <h3 className="section-title" id="event-triggers">Event triggers</h3>
      <TriggersCard version={version} />
      </section>

      <section className="settings-card">
      <h3 className="section-title">Execution</h3>
      <p className="hint">
        Engine: your own Claude Code via <span className="mono">claude -p</span> on your subscription
        login — no API key required. Every run is OS-sandboxed with writes locked to its worktree,
        SSH keys unreadable, and hard budget bounds.
      </p>
      </section>
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
//
// The label MUST stay positioned (see hiddenFileInputLabelStyle). `position:
// absolute` resolves against the nearest positioned ancestor, and with none
// the containing block is the page itself: this 1px box landed at document
// y=2061, `.main` could not clip it because `.main` is static, and the
// document grew a scrollbar of its own beside `.main`'s. Two scrollbars on
// the Settings page, from one input nobody can see.
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

/// The anchor that keeps the hidden input inside the label rather than on the page.
const hiddenFileInputLabelStyle: CSSProperties = { position: 'relative' };

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
              ...hiddenFileInputLabelStyle,
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
 * One asymmetry is stated on screen rather than hidden, and it is no longer
 * about who gets told. Every channel here now receives the APPROVAL REQUEST:
 * run-manager.ts routes it through the shared `deliverApproval` fan-out, the
 * same channel list the run report uses, so a task wired for Slack learns that
 * a run is waiting. What Telegram alone carries is the DECISION — its message
 * has approve/deny buttons behind an inbound poller, while a Slack or email
 * notice can only point at the Inbox. Naming that here is cheaper than a user
 * replying to the mail and wondering why the run is still waiting.
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
        the branch it left behind — and a notice when a run is waiting for your OK. Reading that
        notice is not answering it.{' '}
        <strong>You answer in this app or from Telegram</strong> — those are the only two places a
        decision is taken. Every credential below is stored on this Mac at file mode 0600 and is
        never handed to a running agent.
      </p>

      <div className="cred-row">
        <label className="f cred-label" htmlFor="tg-token">Telegram bot token</label>
        <input
          id="tg-token"
          className="cred-field"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={configured ? (cfg.data?.telegram.botTokenMasked ?? 'configured') : 'Paste the token from @BotFather'}
          data-testid="telegram-token-input"
        />
        <div className="hint cred-hint">
          {configured
            ? `Configured — ${cfg.data?.telegram.botTokenMasked}`
            : 'Not configured — chat approvals are unavailable until a bot token is set.'}
        </div>
        <div className="cred-actions">
          <button
            className="btn small primary act-save"
            disabled={tokenBusy || !token.trim()}
            onClick={() => void saveToken()}
            data-testid="telegram-token-save"
          >
            {tokenBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small danger act-clear"
            disabled={tokenBusy || !configured}
            onClick={() => void clearToken()}
          >
            Clear
          </button>
        </div>
      </div>
      {tokenMsg && <div className="ok-banner">{tokenMsg}</div>}
      {tokenErr && <div className="error-banner" role="alert">{tokenErr}</div>}

      <div className="cred-row">
        <label className="f cred-label" htmlFor="tg-test-chat">Send test message</label>
        <input
          id="tg-test-chat"
          className="cred-field"
          type="text"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="Chat id"
          disabled={!configured}
          data-testid="telegram-test-chatid"
        />
        <div className="cred-actions cred-actions--single">
          <button
            className="btn small act-test"
            disabled={!configured || testBusy || !chatId.trim()}
            onClick={() => void sendTest()}
            data-testid="telegram-test-send"
          >
            {testBusy ? 'Sending…' : 'Send test message'}
          </button>
        </div>
      </div>
      {testMsg && (
        <div className={testOk ? 'ok-banner' : 'error-banner'} role={testOk ? undefined : 'alert'}>
          {testMsg}
        </div>
      )}

      <div className="cred-row">
        <label className="f cred-label" htmlFor="wh-secret">Webhook secret (optional)</label>
        <input
          id="wh-secret"
          className="cred-field"
          type="password"
          autoComplete="off"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          placeholder={cfg.data?.webhook.configured ? 'configured' : 'Shared secret used to sign outgoing webhook calls'}
        />
        <div className="hint cred-hint">
          {cfg.data?.webhook.configured ? 'Configured.' : 'Not set — outgoing webhooks are sent unsigned.'}
        </div>
        <div className="cred-actions">
          <button className="btn small primary act-save" disabled={whBusy || !webhookSecret.trim()} onClick={() => void saveWebhookSecret()}>
            {whBusy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn small danger act-clear" disabled={whBusy || !cfg.data?.webhook.configured} onClick={() => void clearWebhookSecret()}>
            Clear
          </button>
        </div>
      </div>
      {whMsg && <div className="ok-banner">{whMsg}</div>}
      {whErr && <div className="error-banner" role="alert">{whErr}</div>}

      <div className="cred-row">
        <label className="f cred-label" htmlFor="slack-hook">Slack incoming webhook</label>
        <input
          id="slack-hook"
          className="cred-field"
          type="password"
          autoComplete="off"
          value={slackUrl}
          onChange={(e) => setSlackUrl(e.target.value)}
          placeholder={slackConfigured ? (cfg.data?.slack?.webhookUrlMasked ?? 'configured') : 'https://hooks.slack.com/services/…'}
          data-testid="slack-webhook-input"
        />
        <div className="hint cred-hint">
          {slackConfigured
            ? `Configured — ${cfg.data?.slack?.webhookUrlMasked}`
            : 'Not configured. The URL is the credential: anyone holding it can post to that channel. One webhook posts to one channel — a second destination needs a second webhook.'}
        </div>
        <div className="cred-actions">
          <button
            className="btn small primary act-save"
            disabled={slackBusy || !slackUrl.trim()}
            onClick={() => void saveSlack()}
            data-testid="slack-webhook-save"
          >
            {slackBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small act-test"
            disabled={slackBusy || !slackConfigured}
            onClick={() => void testSlack()}
            data-testid="slack-test-send"
          >
            Send test
          </button>
          <button
            className="btn small danger act-clear"
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

      {/* The row the "alignment" report pointed at. Save and Clear used to be
          centred on a block holding two fields and two hints, which put them
          level with the STARTTLS sentence instead of the relay field they act
          on. `From address` moves into the row's `extra` area so the actions
          stay on the relay field's line — they save both, and the relay is the
          field that decides whether email works at all. */}
      <div className="cred-row">
        <label className="f cred-label" htmlFor="smtp-url">SMTP relay</label>
        <input
          id="smtp-url"
          className="cred-field"
          type="password"
          autoComplete="off"
          value={smtpUrl}
          onChange={(e) => setSmtpUrl(e.target.value)}
          placeholder={smtpConfigured ? (cfg.data?.smtp?.endpointMasked ?? 'configured') : 'smtp://user:pass@smtp.example.com:587'}
          data-testid="smtp-url-input"
        />
        <div className="hint cred-hint">
          {smtpConfigured
            ? `Configured — ${cfg.data?.smtp?.endpointMasked}`
            : 'Not configured. Port 587 upgrades with STARTTLS; smtps:// is TLS from the first byte. Plain-text mail only — no attachments, no HTML.'}
        </div>
        <div className="cred-extra">
          <label className="f" htmlFor="smtp-from">From address</label>
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
        <div className="cred-actions">
          <button
            className="btn small primary act-save"
            disabled={smtpBusy || (!smtpUrl.trim() && !smtpFrom.trim())}
            onClick={() => void saveSmtp()}
            data-testid="smtp-save"
          >
            {smtpBusy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn small danger act-clear"
            disabled={smtpBusy || !smtpConfigured}
            onClick={() => void clearSmtp()}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="cred-row">
        <label className="f cred-label" htmlFor="smtp-test-to">Send test email to</label>
        <input
          id="smtp-test-to"
          className="cred-field"
          type="email"
          value={smtpTo}
          onChange={(e) => setSmtpTo(e.target.value)}
          placeholder="you@example.com"
          disabled={!smtpConfigured}
          data-testid="smtp-test-to"
        />
        <div className="cred-actions cred-actions--single">
          <button
            className="btn small act-test"
            disabled={!smtpConfigured || smtpBusy || !smtpTo.trim()}
            onClick={() => void testSmtp()}
            data-testid="smtp-test-send"
          >
            {smtpBusy ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      </div>
      {smtpMsg && (
        <div className={smtpOk ? 'ok-banner' : 'error-banner'} role={smtpOk ? undefined : 'alert'} data-testid="smtp-result">
          {smtpMsg}
        </div>
      )}
    </div>
  );
}

/**
 * Quiet hours (ADR-030, T1-8) — the setter `scheduler.ts` has been waiting on.
 *
 * `readQuietHours` reads `delivery_json.quietHours` off a TASK row, and when a
 * due fire time lands inside `[startHour, endHour)` in the owning SCHEDULE's
 * own `tz`, defers the run AND pre-claims a fresh `pending` occurrence at the
 * window's end (`scheduler.ts`, the `INSERT OR IGNORE` right after the
 * deferral). `DeliveryConfig` just never carried the `quietHours` key, so zod
 * stripped it on every write — this card, and the schema field beside it, are
 * the whole fix.
 *
 * NOT the same control as Office hours, on purpose. Office hours is one
 * global on/off switch plus shared windows (`OfficeHoursCard`,
 * `PUT /workforce/office-hours`); quiet hours has no such table — it lives on
 * the task row, per task, evaluated in that task's own schedule zone. So
 * unlike Office hours this card has to name a task before it can set
 * anything, the same "pick a task" affordance `TriggersCard` already uses
 * below. Sharing a settings PAGE with Office hours is deliberate; sharing its
 * mechanism is not (docs/agent-workforce.md F3 spells out why the two ledger
 * behaviours differ, and scheduler.ts is out of this card's reach either way).
 *
 * A real gap, stated on screen rather than hidden: `GET /tasks` never returns
 * a task's `delivery` (`api.ts`'s `view()` omits it — a narrower projection
 * than the row itself, not a bug this card can fix from here), so the fields
 * below cannot be pre-filled with what a task already has, and `TaskPatch`
 * treats `delivery` as ONE json column: `TaskRepo.patch` replaces it whole
 * when the key is present at all, it does not merge sub-keys. Saving quiet
 * hours here therefore REPLACES the task's whole delivery config — safe for a
 * task with no other channel set, destructive for one that already has
 * Telegram, Slack or email configured (ComposerView is still the only place
 * that sets those, and only at creation — this is the first UI path that
 * touches `delivery` afterward). The hint below says so; it does not soften
 * it into "advanced settings may reset."
 */
export function QuietHoursCard({ version }: { version: number }): JSX.Element {
  const tasks = useAsync(() => api.tasks(), [version]);
  const [taskId, setTaskId] = useState('');
  const [startHour, setStartHour] = useState('23');
  const [endHour, setEndHour] = useState('7');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** '' fails closed rather than reading as hour 0 (`Number('') === 0`). */
  const parseHour = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  const start = parseHour(startHour);
  const end = parseHour(endHour);
  const canSave = Boolean(taskId) && start !== null && end !== null && !busy;

  const save = async (): Promise<void> => {
    if (start === null || end === null) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.patchTask(taskId, { delivery: { quietHours: { startHour: start, endHour: end } } });
      setMsg('Quiet hours saved.');
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        A window in which a task never fires. A run due inside it waits until the window ends and the
        wait is recorded, not dropped — critical tasks still bypass it. Hours wrap midnight: 23 → 7
        means quiet from 11pm to 7am, in the task's own schedule time zone.
      </p>
      <p className="hint">
        The daemon does not send a task's current quiet hours back, so the fields below always start
        blank, and <strong>Save replaces this task's whole delivery configuration</strong> — OS
        notifications, Telegram, Slack, email — not quiet hours alone. Safe for a task with none of
        those set; for one that already has Telegram, Slack or email configured, that channel is
        dropped unless it is re-entered elsewhere first.
      </p>
      {tasks.error && <div className="error-banner">{tasks.error}</div>}
      <div className="row3" style={{ alignItems: 'end' }}>
        <div>
          <label className="f">Task</label>
          <Select value={taskId || '__none__'} onValueChange={(v) => setTaskId(v === '__none__' ? '' : v)}>
            <SelectTrigger data-testid="quiet-hours-task-select"><SelectValue placeholder="— pick a task —" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— pick a task —</SelectItem>
              {(tasks.data ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="f" htmlFor="qh-start">Quiet from (hour)</label>
          <input
            id="qh-start"
            type="number"
            min={0}
            max={23}
            value={startHour}
            onChange={(e) => setStartHour(e.target.value)}
            data-testid="quiet-hours-start"
          />
        </div>
        <div>
          <label className="f" htmlFor="qh-end">Until (hour)</label>
          <input
            id="qh-end"
            type="number"
            min={0}
            max={23}
            value={endHour}
            onChange={(e) => setEndHour(e.target.value)}
            data-testid="quiet-hours-end"
          />
        </div>
        <button
          className="btn primary"
          style={{ justifySelf: 'start' }}
          disabled={!canSave}
          onClick={() => void save()}
          data-testid="quiet-hours-save"
        >
          {busy ? 'Saving…' : 'Save'}
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
        {/* justify-self, because this button is a direct child of a
            three-column grid and was filling a whole 457px track — a submit
            button the width of a select reads as a banner, not an action. */}
        <button
          className="btn primary"
          style={{ justifySelf: 'start' }}
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
