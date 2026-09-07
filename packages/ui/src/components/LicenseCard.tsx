/**
 * LicenseCard (commercial gauntlet §8/10/12): shows the current plan state
 * honestly (free / active / grace / expired), lets the user activate a
 * license key, deactivate, and browse the full capability matrix with real
 * availability. No dark patterns: grace and expiry are explained plainly.
 *
 * The matrix used to answer a question nobody asked. `GET /capabilities` says
 * whether your PLAN entitles you to a feature; the matrix drew that answer as
 * a green "included" tick, which every reader takes to mean "and you can use
 * it here". Nine of the twelve agent-workforce capabilities were ticked while
 * having no screen anywhere in the app. The tick now needs both halves —
 * entitled AND this build has a screen for it — and the screen's location is
 * printed beside it as the evidence. See featureSurfaces.ts for why that list
 * is not maintained here.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { featureSurface, revealFeatureSurface } from './featureSurfaces';

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
            <span className="text-caption font-medium">License key</span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => { setKeyInput(e.target.value); setMsg(null); }}
              placeholder="Paste the key from your receipt"
              aria-label="License key"
              autoComplete="off"
              spellCheck={false}
              data-testid="license-key-input"
              className="w-full rounded-md border border-strong bg-bg px-2 py-1.5 font-mono text-caption"
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

      {/* A disclosure needs to LOOK like one. This was grey caption text with a
          hover-only underline: nothing on screen said it could be clicked, and
          it is the sole way to reach the matrix. The chevron states which way
          it goes, and the underline is now unconditional. */}
      <button
        className="flex w-fit items-center gap-1 text-left text-caption text-muted underline underline-offset-2 hover:text-fg"
        aria-expanded={showMatrix}
        onClick={() => setShowMatrix((v) => !v)}
        data-testid="capability-matrix-toggle"
      >
        {showMatrix ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        {showMatrix ? 'Hide what each plan includes' : 'What does each plan include?'}
      </button>
      {/* No height cap. 300px showed two of six categories and sliced the third
          heading in half, inside a Settings page already thousands of pixels
          tall — it read as a rendering failure, not as a scroll region. The
          list is short enough to simply be read. */}
      {showMatrix && (
        <div className="rounded-lg border border-border p-2" data-testid="capability-matrix">
          {groupByCategory(caps.features).map(([cat, feats]) => (
            <div key={cat}>
              <p className="mb-1 mt-2 text-xxs font-semibold uppercase tracking-wide text-dim">{cat}</p>
              {feats.map((f) => <CapabilityRow key={f.key} feature={f} />)}
            </div>
          ))}
          <p className="hint" style={{ margin: '6px 4px' }}>
            Generated from this build, not from a brochure. A tick means two things at once: your
            plan includes it, <em>and</em> this build has a screen for it — the location beside it is
            where to find it. Where there is no location, your plan still includes the capability but
            Clockwork cannot point you at a screen for it — look in the section it belongs to, or
            drive it through the daemon API.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One capability, in three honest states:
 *   entitled + a screen in this build  → tick, plus where the screen is
 *   entitled, no screen registered     → no tick, and no claim either way
 *   not entitled                       → unchanged (warning glyph, `planned` chip)
 *
 * The registry is read HERE, during render, never at module scope: a surface
 * registers when its module is imported, which can happen after this one is.
 */
function CapabilityRow({ feature }: { feature: Capabilities['features'][number] }): JSX.Element {
  const surface = feature.enabled ? featureSurface(feature.key) : undefined;
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-compact" data-testid={`capability-${feature.key}`}>
      {!feature.enabled && <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-dim" aria-hidden />}
      {feature.enabled && surface && (
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-accent"
          aria-label="included in your plan, with a screen in this build"
          data-testid={`capability-tick-${feature.key}`}
        />
      )}
      {feature.enabled && !surface && (
        <Circle className="h-3.5 w-3.5 shrink-0 text-dim" aria-label="included in your plan" />
      )}
      <span>{feature.label}</span>
      {feature.limit && <span className="text-xxs text-dim">({feature.limit})</span>}
      {surface && (
        <button
          className="ml-auto text-xxs text-dim underline-offset-2 hover:text-fg hover:underline"
          data-testid={`capability-goto-${feature.key}`}
          onClick={() => revealFeatureSurface(surface)}
        >
          {surface.where}
        </button>
      )}
      {!feature.enabled && feature.status === 'planned' && (
        <span className="chip" style={{ marginLeft: 'auto' }}>planned</span>
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

