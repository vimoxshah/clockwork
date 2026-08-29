/**
 * ByokCard (ADR-027 + commercial gauntlet §14/21): BYOK provider management.
 * "Connect a provider" opens ProviderConnectFlow (guided, test-before-save).
 * Existing connections render as status cards with Test / Set default / Rotate
 * / Remove actions. Raw keys never touch the client after submit.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Star } from 'lucide-react';
import { api } from '../api';
import { ProviderConnectFlow, friendlyByokError } from './ProviderConnectFlow';

interface ByokConfig {
  id: string;
  kind: string;
  label: string;
  base_url?: string;
  auth: 'keychain' | 'env';
  hint?: string;
  env_var?: string;
  default_model: string;
  model_label?: string;
  is_default?: boolean;
  last_validated_at: number | null;
  last_error: string | null;
}

type KindMeta = Record<string, {
  label: string;
  defaultBaseUrl: string;
  models: Array<{ id: string; name?: string; context?: number; inPerM?: number; outPerM?: number }>;
}>;

function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function ByokCard({ version }: { version: number }): JSX.Element {
  const [data, setData] = useState<{ configs: ByokConfig[]; meta: KindMeta } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);

  const load = async (): Promise<void> => {
    try {
      setData(await api.byok() as { configs: ByokConfig[]; meta: KindMeta });
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };
  useEffect(() => { void load(); }, [version]);

  return (
    <div>
      {err && <div className="error-banner">{err}</div>}
      {!data && !err && <div className="state-line"><span className="spinner" /> Loading providers…</div>}
      {data && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            Bring your own keys — billed directly by each provider, never by Clockwork. Keys live in
            this Mac's Keychain; Clockwork stores only a redacted hint.
          </p>

          {data.configs.map((c) => (
            <ConnectedProviderRow key={c.id} cfg={c} onChanged={load} />
          ))}

          {data.configs.length === 0 && (
            <div className="empty" style={{ padding: 20 }}>
              No API providers connected yet. CLI engines below use their own logins; connect a
              provider to schedule work on models you already pay for.
            </div>
          )}

          <button className="btn small primary" style={{ marginTop: 8 }} onClick={() => setFlowOpen(true)} data-testid="connect-provider-btn">
            {data.configs.length === 0 ? 'Connect your first provider' : '+ Connect another provider'}
          </button>

          <ProviderConnectFlow
            meta={data.meta}
            open={flowOpen}
            onOpenChange={setFlowOpen}
            onDone={() => void load()}
          />
        </>
      )}
    </div>
  );
}

function ConnectedProviderRow({ cfg, onChanged }: { cfg: ByokConfig; onChanged: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);

  const doTest = async (): Promise<void> => {
    setBusy('test'); setTestErr(null);
    try {
      const r = await api.byokTest(cfg.id);
      if (!r.ok) setTestErr(r.error ?? 'validation failed');
    } catch (e) { setTestErr(String((e as Error).message ?? e)); }
    setBusy(null);
    await onChanged();
  };

  const doRotate = async (): Promise<void> => {
    setBusy('rotate');
    try {
      await api.byokRotate(cfg.id, newKey.trim());
      setNewKey(''); setRotating(false);
      await onChanged();
    } catch (e) { setTestErr(friendlyByokError(String((e as Error).message ?? e))); }
    setBusy(null);
  };

  const doDelete = async (): Promise<void> => {
    setBusy('delete');
    try {
      await api.byokDelete(cfg.id);
      await onChanged();
    } catch (e) {
      setTestErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const doSetDefault = async (): Promise<void> => {
    setBusy('default');
    try {
      await api.byokSetDefault(cfg.id);
      await onChanged();
    } catch (e) {
      setTestErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(cfg.last_validated_at) && !cfg.last_error;
  const stateChip = cfg.last_error ? 'invalid' : cfg.last_validated_at ? 'connected' : 'untested';

  return (
    <div className="tasklist-row" style={{ flexDirection: 'column', alignItems: 'stretch', marginBottom: 8 }} data-testid={`byok-row-${cfg.kind}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <KeyRound className="h-4 w-4 text-dim" aria-hidden />
        <strong>{cfg.label}</strong>
        {cfg.is_default && (
          <span className="chip completed" title="Used when a task does not pick a provider">
            <Star className="mr-1 inline h-3 w-3" aria-hidden />default
          </span>
        )}
        <span className={`chip ${cfg.last_error ? 'failed' : connected ? 'completed' : ''}`}>{stateChip}</span>
        <span className="hint mono" style={{ margin: 0 }}>
          {cfg.model_label ?? cfg.default_model} · {cfg.auth === 'keychain' ? (cfg.hint ?? '••••') : `$${cfg.env_var}`}
        </span>
        {cfg.last_validated_at && !cfg.last_error && (
          <span className="hint" style={{ margin: 0 }}>validated {relTime(cfg.last_validated_at)}</span>
        )}
        <span className="grow" />
        {!cfg.is_default && (
          <button className="btn small" disabled={busy !== null} onClick={() => void doSetDefault()} title="Use this provider when a task doesn't specify one">
            Set default
          </button>
        )}
        <button className="btn small" disabled={busy !== null} onClick={() => void doTest()}>
          {busy === 'test' ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}
          Test
        </button>
        {cfg.auth === 'keychain' && (
          <button className="btn small" onClick={() => setRotating((v) => !v)}>Replace key</button>
        )}
        <button className="btn danger small" disabled={busy !== null} onClick={() => void doDelete()}>Remove</button>
      </div>

      {rotating && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <div className="relative" style={{ flex: 1 }}>
            <input
              type={showNewKey ? 'text' : 'password'}
              placeholder="Paste new API key"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              aria-label={`New key for ${cfg.label}`}
              autoComplete="off"
              className="w-full rounded-md border border-strong bg-bg px-2 py-1.5 pr-9 font-mono text-xs"
            />
            <button type="button" onClick={() => setShowNewKey((v) => !v)} aria-label={showNewKey ? 'Hide key' : 'Show key'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-dim hover:text-fg">
              {showNewKey ? 'hide' : 'show'}
            </button>
          </div>
          <button className="btn small primary" disabled={newKey.trim().length < 8 || busy !== null} onClick={() => void doRotate()}>Save key</button>
        </div>
      )}

      {(testErr ?? cfg.last_error) && (
        <div className="error-banner" role="alert" style={{ marginTop: 6 }}>
          {friendlyByokError(testErr ?? cfg.last_error)}
        </div>
      )}
    </div>
  );
}

