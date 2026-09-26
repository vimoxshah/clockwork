/**
 * Packs section (P6): installed packs with versions, install from file or
 * URL with preview-first, honest uninstall.
 *
 * The install dialog never executes anything on preview: preview shows the
 * manifest, the signature state (trusted key, unknown fingerprint, or bad),
 * and per-template security flags. Installing an unknown key requires the
 * explicit trust checkbox beside the fingerprint — TOFU with a human in the
 * loop, not a silent pin.
 */
import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';

interface PackPreviewT {
  manifest: { name: string; version: string; publisher?: string };
  verified: { ok: boolean; keyId?: string; reason?: string; message?: string };
  templates: Array<{ name: string; schemaOk: boolean; preview: { flags: Array<{ level: string; text: string }> } | null }>;
  blocked: boolean;
  blockedReasons: string[];
}

export function PacksSection({ version }: { version: number }): JSX.Element {
  const installed = useAsync(() => api.packsInstalled(), [version]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PackPreviewT | null>(null);
  const [previewSource, setPreviewSource] = useState<{ pack?: unknown; url?: string } | null>(null);
  const [trustKey, setTrustKey] = useState(false);
  const [lastUninstall, setLastUninstall] = useState<{ removed: number; kept: string[] } | null>(null);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    setLastUninstall(null);
    try {
      const r = await fn();
      installed.reload();
      return r;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async (source: { pack?: unknown; url?: string }): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    setPreview(null);
    setPreviewSource(source);
    setTrustKey(false);
    try {
      setPreview(await api.packsPreview(source));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    try {
      await doPreview({ pack: JSON.parse(await f.text()) });
    } catch {
      setErr('That file is not JSON.');
    }
  };

  const install = async (): Promise<void> => {
    if (!previewSource) return;
    const r = await run(() => api.packsInstall({ ...previewSource, trustKey: trustKey || undefined }));
    if (r) {
      setMsg(`Installed — ${r.tasks.length} task(s) arrive disabled; review and schedule them from Tasks.`);
      setPreview(null);
      setPreviewSource(null);
      setTrustKey(false);
    }
  };

  const packs: Array<{ name: string; version: string; publisher: string; tasks: number }> = (installed.data as any)?.packs ?? [];

  return (
    <div data-testid="packs-section">
      <p className="hint" style={{ marginTop: 0 }}>
        A pack is a signed bundle of templates — one install for a team&apos;s whole workflow.
        Preview always runs first: signature state, per-template flags, and what would land.
      </p>
      {installed.error && <div className="error-banner" role="alert">Couldn’t load installed packs: {installed.error}</div>}
      {packs.length === 0 && !installed.loading && <p className="hint">No packs installed.</p>}
      {packs.map((p) => (
        <div key={p.name} className="tasklist-row" data-testid={`pack-${p.name}`}>
          <div className="grow">
            <strong>{p.name}</strong> <span className="chip">{p.version}</span>{' '}
            <span className="hint">
              {p.publisher} · {p.tasks} task{p.tasks === 1 ? '' : 's'}
            </span>
          </div>
          <button
            className="btn small danger"
            disabled={busy}
            onClick={() => {
              if (confirm(`Uninstall pack “${p.name}”? Only untouched tasks go; anything you enabled or ran stays.`)) {
                void (async () => {
                  const r = await run(() => api.packsUninstall(p.name));
                  if (r) setLastUninstall({ removed: r.removed, kept: r.kept });
                })();
              }
            }}
          >
            Uninstall
          </button>
        </div>
      ))}
      <div className="cred-row">
        <label className="f cred-label" htmlFor="pack-url">
          Install a pack
        </label>
        <input
          id="pack-url"
          className="cred-field"
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/nightly-triage.clockwork-pack.json"
          data-testid="pack-url-input"
        />
        <div className="hint cred-hint">URLs fetch over https only — anything else refuses before parsing.</div>
        <div className="cred-actions">
          <button
            className="btn small primary"
            disabled={busy || !url.trim()}
            onClick={() => void doPreview({ url: url.trim() })}
            data-testid="pack-preview-url"
          >
            {busy ? 'Checking…' : 'Preview URL'}
          </button>
          <label className="btn small" data-testid="pack-file-label">
            Preview file…
            <input
              type="file"
              accept="application/json,.json"
              hidden
              data-testid="pack-file-input"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>
      {preview && (
        <div className="mt-2 rounded-lg border border-border bg-bg p-3" data-testid="pack-preview">
          <strong>
            {preview.manifest.name} {preview.manifest.version}
          </strong>{' '}
          <span className="hint">by {preview.manifest.publisher ?? 'unknown publisher'}</span>
          <div className="mt-2 text-xs" data-testid="pack-verify">
            {preview.verified.ok ? (
              <span>✓ Signed by trusted key {(preview.verified as any).keyId}.</span>
            ) : (
              <span>
                ! Signature: {(preview.verified as any).message}{' '}
                {(preview.verified as any).reason === 'unknown_key' && (preview.verified as any).keyId && (
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={trustKey}
                      onChange={(e) => setTrustKey(e.target.checked)}
                      data-testid="pack-trust-key"
                    />
                    <span>
                      Trust fingerprint <code className="mono" data-testid="pack-key-fingerprint">{(preview.verified as any).keyId}</code> for
                      this publisher? Check it against the publisher&apos;s own channel first — ticking pins it
                      for all future installs.
                    </span>
                  </label>
                )}
                {(preview.verified as any).reason === 'bad_signature' && (
                  <span> Re-download the pack from the publisher; there is no override for a bad signature.</span>
                )}
              </span>
            )}
          </div>
          <ul className="mt-2 text-xs">
            {preview.templates.map((t) => (
              <li key={t.name} data-testid={`pack-template-${t.name}`}>
                {t.name}
                {!t.schemaOk && ' — BAD SCHEMA (skipped at install)'}
                {(t.preview?.flags ?? []).map((f, i) => (
                  <span key={i} className={`chip ${f.level === 'red' ? 'failed' : ''}`} style={{ marginLeft: 6 }}>
                    {f.level}: {f.text}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {preview.blocked && (
            <div className="error-banner" role="alert" data-testid="pack-blocked">
              Blocked: {preview.blockedReasons.join(' · ')}
            </div>
          )}
          <div className="cred-actions" style={{ marginTop: 8 }}>
            <button
              className="btn small primary"
              data-testid="pack-install-button"
              disabled={busy || preview.blocked || (!preview.verified.ok && !trustKey)}
              onClick={() => void install()}
            >
              {busy ? 'Installing…' : 'Install pack'}
            </button>
          </div>
        </div>
      )}
      {msg && <div className="ok-banner">{msg}</div>}
      {lastUninstall && (
        <div className="ok-banner" data-testid="pack-uninstall-result">
          Removed {lastUninstall.removed} untouched task{lastUninstall.removed === 1 ? '' : 's'}
          {lastUninstall.kept.length > 0 &&
            ` — kept ${lastUninstall.kept.length} you had enabled or run (${lastUninstall.kept.slice(0, 3).join(', ')}${lastUninstall.kept.length > 3 ? ', …' : ''}), yours now.`}
        </div>
      )}
      {err && (
        <div className="error-banner" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
