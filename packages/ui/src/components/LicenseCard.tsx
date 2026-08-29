/**
 * LicenseCard (commercial gauntlet §8/10/12): shows the current plan state
 * honestly (free / active / grace / expired), lets the user activate a
 * license key, deactivate, and browse the full capability matrix with real
 * availability. No dark patterns: grace and expiry are explained plainly.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../api';

type Capabilities = Awaited<ReturnType<typeof api.capabilities>>;

const STATE_COPY: Record<string, { title: string; detail: string; tone: 'ok' | 'warn' | 'muted' }> = {
  none: { title: 'Clockwork Free', detail: 'You are on the free tier. Everything local works — no clock, no account required.', tone: 'muted' },
  active: { title: 'Subscription active', detail: 'Thanks for supporting Clockwork. Entitlements are verified locally and work offline.', tone: 'ok' },
  grace: { title: 'Reconnecting needed', detail: 'Your subscription could not be revalidated recently. Everything keeps working for a grace period — reconnect to confirm.', tone: 'warn' },
  expired: { title: 'Subscription ended', detail: 'Clockwork has returned to the free tier. Your runs, history, and provider keys are untouched.', tone: 'warn' },
};

function fmtDate(ts?: number): string {
  return ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

export function LicenseCard({ version }: { version: number }): JSX.Element {
  const caps = useCaps(version);
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showMatrix, setShowMatrix] = useState(false);
  const [activating, setActivating] = useState(false);

  if (!caps) return <p className="hint">Reading plan…</p>;

  const ent = caps.entitlement;
  const copy = STATE_COPY[ent.state] ?? STATE_COPY.none;

  const activate = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    try {
      await api.licenseActivate(keyInput.trim());
      setKeyInput('');
      setMsg({ ok: true, text: 'License activated — thank you.' });
    } catch (e) {
      const raw = String((e as Error).message ?? e).replace(/^.*error.?[:"]*/i, '');
      setMsg({ ok: false, text: raw });
    }
    setBusy(false);
  };

  const deactivate = async (): Promise<void> => {
    setBusy(true);
    try { await api.licenseDeactivate(); } catch { /* status reload shows truth */ }
    setBusy(false);
  };

  return (
    <div className="tasklist-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ShieldCheck className="h-4 w-4 text-dim" aria-hidden />
        <strong data-testid="license-state-title">{copy.title}</strong>
        <span className={`chip ${copy.tone === 'ok' ? 'completed' : copy.tone === 'warn' ? 'failed' : ''}`} data-testid="license-tier-chip">
          {ent.state === 'none' ? 'free tier' : `${ent.plan ?? ent.tier} · ${ent.state}`}
        </span>
        {ent.expiresAt && ent.state !== 'expired' && (
          <span className="hint" style={{ margin: 0 }}>renews / expires {fmtDate(ent.expiresAt)}</span>
        )}
        <span className="grow" />
        {ent.state !== 'none' && (
          <button className="btn small danger" disabled={busy} onClick={() => void deactivate()}>Deactivate</button>
        )}
      </div>
      <p className="hint" style={{ margin: 0 }}>{copy.detail}</p>

      {!activating && ent.state === 'none' && (
        <button className="btn small" onClick={() => setActivating(true)} data-testid="license-activate-open">
          I have a license key
        </button>
      )}
      {activating && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">License key</span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => { setKeyInput(e.target.value); setMsg(null); }}
              placeholder="Paste the key from your receipt"
              aria-label="License key"
              autoComplete="off"
              spellCheck={false}
              data-testid="license-key-input"
              className="w-full rounded-md border border-strong bg-bg px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small primary" disabled={busy || !keyInput.trim()} onClick={() => void activate()} data-testid="license-activate-btn">
              Activate
            </button>
            <button className="btn small" disabled={busy} onClick={() => { setActivating(false); setMsg(null); }}>Cancel</button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Verified locally against Clockwork's public key — activation works once and then never
            needs to phone home for everyday use.
          </p>
        </div>
      )}

      {msg && (
        <div className={msg.ok ? 'ok-banner' : 'error-banner'} role={msg.ok ? 'status' : 'alert'} data-testid="license-msg">
          {msg.text}
        </div>
      )}

      <button
        className="text-left text-xs text-dim underline-offset-2 hover:text-fg hover:underline"
        aria-expanded={showMatrix}
        onClick={() => setShowMatrix((v) => !v)}
        data-testid="capability-matrix-toggle"
      >
        {showMatrix ? '− Hide what each plan includes' : 'What does each plan include?'}
      </button>
      {showMatrix && (
        <div className="rounded-lg border border-border p-2" style={{ maxHeight: 300, overflow: 'auto' }}>
          {groupByCategory(caps.features).map(([cat, feats]) => (
            <div key={cat}>
              <p className="mb-1 mt-2 text-xxs font-semibold uppercase tracking-wide text-dim">{cat}</p>
              {feats.map((f) => (
                <div key={f.key} className="flex items-center gap-2 px-1 py-1 text-body">
                  {f.enabled
                    ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-label="included" />
                    : <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-dim" aria-hidden />}
                  <span>{f.label}</span>
                  {f.limit && <span className="text-xxs text-dim">({f.limit})</span>}
                  {!f.enabled && f.status === 'planned' && <span className="chip" style={{ marginLeft: 'auto' }}>planned</span>}
                </div>
              ))}
            </div>
          ))}
          <p className="hint" style={{ margin: '6px 4px' }}>
            This list is generated from the app itself — it always matches what this build enforces.
          </p>
        </div>
      )}
    </div>
  );
}

function useCaps(version: number): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    void api.capabilities().then(setCaps).catch(() => setCaps(null));
  }, [version]);
  return caps;
}

function groupByCategory(features: Capabilities['features']): Array<[string, Capabilities['features']]> {
  const map = new Map<string, Capabilities['features']>();
  for (const f of features) {
    const list = map.get(f.category) ?? [];
    list.push(f);
    map.set(f.category, list);
  }
  return [...map.entries()];
}

