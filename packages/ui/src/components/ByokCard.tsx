/**
 * ByokCard (ADR-027): BYOK provider management UI.
 * Add → choose kind → auth mode → credential (sent once to daemon keychain,
 * never persisted client-side) → default model → validate/rotate/remove.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

interface ByokConfig {
  id: string;
  kind: string;
  label: string;
  base_url?: string;
  auth: 'keychain' | 'env';
  hint?: string;
  env_var?: string;
  default_model: string;
  last_validated_at: number | null;
  last_error: string | null;
}

type KindMeta = Record<string, {
  label: string;
  defaultBaseUrl: string;
  authOptions: Array<{ mode: string; label: string; detail: string }>;
  models: Array<{ id: string; context: number; inPerM: number; outPerM: number }>;
}>;

export function ByokCard({ version }: { version: number }): JSX.Element {
  const [data, setData] = useState<{ configs: ByokConfig[]; meta: KindMeta } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span className="hint" style={{ margin: 0 }}>
              Bring your own keys — stored in your Mac's Keychain, billed directly by each provider. Clockwork never sees or stores the raw key.
            </span>
            <button className="btn small primary" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : '+ Add provider'}
            </button>
          </div>

          {adding && data.meta && (
            <ByokAddForm
              meta={data.meta}
              onDone={() => { setAdding(false); void load(); }}
            />
          )}

          {data.configs.length === 0 && !adding && (
            <div className="empty" style={{ padding: 20 }}>
              No API providers configured yet. CLI engines below use their own logins; add an API provider to run tasks with your own keys.
            </div>
          )}

          {data.configs.map((c) => (
            <ByokRow key={c.id} cfg={c} onChanged={load} />
          ))}
        </>
      )}
    </div>
  );
}

function ByokRow({ cfg, onChanged }: { cfg: ByokConfig; onChanged: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState('');

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
      await api.byokRotate(cfg.id, newKey);
      setNewKey(''); setRotating(false);
      await onChanged();
    } catch (e) { setTestErr(String((e as Error).message ?? e)); }
    setBusy(null);
  };

  const doDelete = async (): Promise<void> => {
    setBusy('delete');
    await api.byokDelete(cfg.id);
    await onChanged();
  };

  const validated = cfg.last_validated_at
    ? new Date(cfg.last_validated_at).toLocaleString()
    : null;

  return (
    <div className="tasklist-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>{cfg.label}</strong>
        <span className={`chip ${cfg.last_error || (!validated && cfg.auth === 'keychain') ? 'failed' : validated ? 'completed' : ''}`}>
          {cfg.last_error ? 'invalid' : validated ? 'connected' : 'untested'}
        </span>
        <span className="hint mono" style={{ margin: 0 }}>
          {cfg.kind} · {cfg.default_model} · {cfg.auth === 'keychain' ? (cfg.hint ?? '••••') : `$${cfg.env_var}`}
        </span>
        {validated && <span className="hint" style={{ margin: 0 }}>validated {validated}</span>}
        <span className="grow" />
        <button className="btn small" disabled={busy !== null} onClick={() => void doTest()}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {cfg.auth === 'keychain' && (
          <button className="btn small" onClick={() => setRotating((v) => !v)}>Rotate key</button>
        )}
        <button className="btn danger small" disabled={busy !== null} onClick={() => void doDelete()}>Remove</button>
      </div>
      {rotating && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="password"
            placeholder="Paste new API key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            style={{ flex: 1 }}
            aria-label={`New key for ${cfg.label}`}
          />
          <button className="btn small primary" disabled={newKey.length < 8 || busy !== null} onClick={() => void doRotate()}>Save</button>
        </div>
      )}
      {(testErr ?? cfg.last_error) && (
        <div className="error-banner" role="alert" style={{ marginTop: 6 }}>
          {testErr ?? cfg.last_error}
        </div>
      )}
    </div>
  );
}

function ByokAddForm({ meta, onDone }: { meta: KindMeta; onDone: () => void }): JSX.Element {
  const kinds = Object.keys(meta);
  const [kind, setKind] = useState(kinds[0]);
  const [label] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authMode, setAuthMode] = useState<'subscription_cli' | 'api_key'>('api_key');
  const [secret, setSecret] = useState('');
  const [envVar, setEnvVar] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const m = meta[kind];
  const cliEngineFor = m.defaultBaseUrl.includes('anthropic') ? "the 'claude' CLI engine below" : m.defaultBaseUrl.includes('openai') ? "the 'codex' CLI engine below" : null;

  const submit = async (): Promise<void> => {
    setBusy(true); setFormErr(null);
    try {
      await api.byokCreate({
        kind,
        label: label.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        auth: 'keychain',
        secret: secret || undefined,
        env_var: envVar || undefined,
        default_model: model,
      });
      onDone();
    } catch (e) {
      setFormErr(String((e as Error).message ?? e).replace(/^.*error.?[:"]*/i, ''));
    }
    setBusy(false);
  };

  return (
    <div className="tasklist-row" style={{ flexDirection: 'column', gap: 12, marginBottom: 14 }}>
      {/* step 1: pick provider */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="hint">Provider</span>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setCustomModel(false); setAuthMode('api_key'); }} style={{ padding: '6px 8px' }}>
          {kinds.map((k) => <option key={k} value={k}>{meta[k].label}</option>)}
        </select>
      </label>

      {/* step 2: how do you want to use it? */}
      <div>
        <span className="hint">How do you want to use {m.label}?</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {m.authOptions.map((ao) => (
            <label key={ao.mode + ao.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <input
                type="radio"
                name={`auth-${kind}`}
                checked={authMode === ao.mode}
                onChange={() => setAuthMode(ao.mode as 'subscription_cli' | 'api_key')}
                disabled={ao.mode === 'subscription_cli'}
              />
              <span>
                <strong>{ao.label}</strong>{' '}
                <span className="hint">{ao.detail}</span>
              </span>
            </label>
          ))}
        </div>
        {m.authOptions.some((a) => a.mode === 'subscription_cli') && (
          <div className="hint" style={{ marginTop: 4 }}>
            Subscription usage runs through the installed CLI engine{cliEngineFor ? ` (${cliEngineFor})` : ''} — configure nothing here.
            {' '}API-key usage is a separate billing system from any subscription you may have.
          </div>
        )}
      </div>

      {authMode === 'api_key' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="hint">
            {kind === 'custom_openai' ? 'API key (leave empty if your endpoint needs none)' : 'API key'} — sent once to this Mac's Keychain
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={secret ? 'enter' : envVar ? 'env' : ''}
                onChange={(e) => {
                  if (e.target.value === 'enter') { setEnvVar(''); }
                  else if (e.target.value === 'env') { setSecret(''); setEnvVar(envVar || 'MY_API_KEY_ENV_VAR'); }
                  else { setSecret(''); setEnvVar(''); }
                }}
                style={{ width: 150, padding: '6px 8px' }}
                aria-label="Credential source"
              >
                <option value="">Choose…</option>
                <option value="enter">Enter key now</option>
                <option value="env">Read from env var</option>
              </select>
              {envVar ? (
                <input value={envVar} onChange={(e) => setEnvVar(e.target.value.toUpperCase())} placeholder="ENV_VAR_NAME" style={{ flex: 1 }} aria-label="Environment variable name" />
              ) : (
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="sk-…" style={{ flex: 1 }} autoComplete="off" aria-label="API key" />
              )}
            </div>
        </label>
      )}

      {(kind === 'custom_openai' || ['openrouter'].includes(kind)) && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="hint">Base URL {kind === 'custom_openai' ? '(required)' : '(optional override)'}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={m.defaultBaseUrl} style={{ fontFamily: 'var(--mono, monospace)' }} />
        </label>
      )}

      {/* step 3: default model */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="hint">Default model</span>
        {m.models.length > 0 && !customModel ? (
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 420, padding: '6px 8px' }}>
            <option value="">Choose a model…</option>
            {m.models.map((mo) => (
              <option key={mo.id} value={mo.id}>
                {mo.id} · {(mo.context / 1000).toFixed(0)}k ctx · ${mo.inPerM}/M in · ${mo.outPerM}/M out
              </option>
            ))}
          </select>
        ) : null}
        {m.models.length > 0 && (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={customModel} onChange={(e) => { setCustomModel(e.target.checked); setModel(''); }} />
            <span className="hint">Enter a custom model id instead</span>
          </label>
        )}
        {(customModel || m.models.length === 0) && (
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={kind === 'custom_openai' ? 'llama3.2' : 'model-id'} style={{ maxWidth: 420 }} />
        )}
      </label>

      {formErr && <div className="error-banner" role="alert">{formErr}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn small primary" disabled={busy || !model.trim()} onClick={() => void submit()}>
          {busy ? 'Saving & validating…' : 'Save provider'}
        </button>
      </div>
    </div>
  );
}
