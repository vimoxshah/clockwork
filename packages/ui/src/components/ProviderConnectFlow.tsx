/**
 * ProviderConnectFlow (commercial gauntlet §14-16): guided, keyboard-first
 * provider setup. Stage 1 pick a provider card, stage 2 enter the API key
 * (always visible, masked with reveal), stage 3 choose a model + test the
 * connection BEFORE anything is saved. Credentials go once to the daemon
 * keychain; nothing is persisted client-side.
 */
import { useState } from 'react';
import { Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { ModelSelector, type SelectorModel } from './ModelSelector';
import { api } from '../api';
import { cn } from '../lib/cn';

export interface FlowKindMeta {
  [kind: string]: {
    label: string;
    defaultBaseUrl: string;
    models: Array<SelectorModel & { vision?: boolean; tools?: boolean; reasoning?: boolean }>;
  };
}

const PROVIDER_CARDS: Array<{ kind: string; blurb: string }> = [
  { kind: 'anthropic', blurb: 'Claude models · console.anthropic.com' },
  { kind: 'openai', blurb: 'GPT models · platform.openai.com' },
  { kind: 'google', blurb: 'Gemini models · aistudio.google.com' },
  { kind: 'openrouter', blurb: 'One key, hundreds of models' },
  { kind: 'deepseek', blurb: 'DeepSeek V3 · economical' },
  { kind: 'xai', blurb: 'Grok models' },
  { kind: 'mistral', blurb: 'Mistral Large · La Plateforme' },
  { kind: 'zai', blurb: 'GLM models · Z.ai open platform' },
  { kind: 'custom_openai', blurb: 'Ollama, vLLM, LM Studio, gateways' },
];

/** Human-readable failure reasons; never show bare "HTTP 401" to users. */
export function friendlyByokError(raw: string | null | undefined): string {
  const r = raw ?? '';
  if (/401|403|unauthorized|invalid.*key|authentication/i.test(r)) return 'The API key was rejected. Double-check that you pasted the full key for the correct account, then try again.';
  if (/429|rate/i.test(r)) return 'The provider is rate-limiting this key. Wait a minute and test again — the key itself is fine.';
  if (/402|quota|billing|credit/i.test(r)) return 'The provider accepted the key but the account has no billing/quota left. Add credits at the provider dashboard.';
  if (/404/i.test(r)) return 'Endpoint not found. If you changed the Base URL, verify it (it usually ends in /v1).';
  if (/5\d\d|bad gateway|unavailable|outage/i.test(r)) return 'The provider seems to be having an outage. Try again shortly.';
  if (/fetch|network|ENOTFOUND|timed?\s?out|abort/i.test(r)) return 'Could not reach the provider. Check your internet connection (and any VPN/firewall), then retry.';
  if (/API key required|min 8 chars/i.test(r)) return 'Paste an API key first (at least 8 characters).';
  return r ? `Connection failed: ${r}` : 'Connection failed for an unknown reason.';
}

const KEYCHAIN_NOTE = 'Your key is stored securely in this Mac\'s Keychain. It is never written to files, logs, or synced anywhere — Clockwork only keeps a redacted hint like “••••9A2F”.';

function stageOf(s: number): string { return ['Provider', 'Credentials', 'Model & test'][s] ?? ''; }

export function ProviderConnectFlow({
  meta,
  open,
  onOpenChange,
  onDone,
}: {
  meta: FlowKindMeta;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}): JSX.Element {
  const [stage, setStage] = useState(0);
  const [kind, setKind] = useState<string>('anthropic');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [modelId, setModelId] = useState('');
  const [modelLabel, setModelLabel] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const m = meta[kind];
  const models: SelectorModel[] = m?.models ?? [];
  const keyLooksShort = secret.trim().length < 8 && kind !== 'custom_openai';

  const reset = (): void => {
    setStage(0); setKind('anthropic'); setSecret(''); setShowSecret(false);
    setModelId(''); setModelLabel(undefined); setName(''); setBaseUrl('');
    setAdvanced(false); setTesting(false); setTestResult(null); setSaving(false); setFormErr(null);
  };

  const close = (v: boolean): void => { onOpenChange(v); if (!v) reset(); };

  const runTest = async (): Promise<void> => {
    setTesting(true); setTestResult(null); setFormErr(null);
    try {
      const r = await api.byokValidate({ kind, ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}), secret: secret.trim() });
      setTestResult({ ok: r.ok, error: r.error ?? null });
    } catch (e) {
      setTestResult({ ok: false, error: String((e as Error).message ?? e) });
    }
    setTesting(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true); setFormErr(null);
    try {
      await api.byokCreate({
        kind,
        label: name.trim() || undefined,
        ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
        auth: 'keychain',
        secret: secret.trim(),
        default_model: modelId,
        ...(modelLabel ? { model_label: modelLabel } : {}),
      });
      close(false);
      onDone();
    } catch (e) {
      setFormErr(String((e as Error).message ?? e));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl" data-testid="provider-connect-flow">
        <DialogTitle>Connect a provider</DialogTitle>
        <DialogDescription>
          Step {stage + 1} of 3 — {stageOf(stage)}. Your key is verified with the provider before anything is saved.
        </DialogDescription>

        {stage === 0 && (
          <div className="mt-3 grid max-h-[55vh] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2" role="listbox" aria-label="Choose a provider">
            {PROVIDER_CARDS.filter((c) => meta[c.kind]).map((c) => (
              <button
                key={c.kind}
                role="option"
                aria-selected={kind === c.kind}
                onClick={() => { setKind(c.kind); setStage(1); setTestResult(null); }}
                data-testid={`provider-card-${c.kind}`}
                className={cn(
                  'rounded-xl border p-3 text-left transition-colors',
                  'border-border hover:border-strong hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-accent',
                  kind === c.kind && 'border-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  <strong className="text-ui">{meta[c.kind].label}</strong>
                  {kind === c.kind && <Check className="h-4 w-4 text-accent" />}
                </span>
                <span className="mt-0.5 block text-xxs text-dim">{c.blurb}</span>
              </button>
            ))}
          </div>
        )}

        {stage === 1 && (
          <div className="mt-3 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-ui font-medium">API key for {m?.label}</span>
              <div className="relative">
                <input
                  autoFocus
                  type={showSecret ? 'text' : 'password'}
                  value={secret}
                  onChange={(e) => { setSecret(e.target.value); setTestResult(null); }}
                  placeholder={kind === 'custom_openai' ? 'Optional — leave empty if your endpoint needs no key' : 'Paste your API key (sk-… or similar)'}
                  aria-label="API key"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="api-key-input"
                  className="h-10 w-full rounded-lg border border-strong bg-bg px-3 pr-10 font-mono text-ui focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? 'Hide key' : 'Show key'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-dim hover:text-fg"
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <p className="-mt-2 text-xs leading-relaxed text-dim">{KEYCHAIN_NOTE}</p>

            <button
              onClick={() => setAdvanced((v) => !v)}
              aria-expanded={advanced}
              className="w-fit text-xs text-dim underline-offset-2 hover:text-fg hover:underline"
            >
              {advanced ? '− Hide advanced settings' : '+ Advanced settings'}
            </button>
            {advanced && (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium">Connection name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${m?.label ?? 'Provider'} (work)`} className="h-9 rounded-lg border border-strong bg-bg px-3 text-ui focus:outline-none focus:ring-2 focus:ring-accent" />
                </label>
                {(kind === 'custom_openai' || kind === 'openrouter') && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Base URL</span>
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={m?.defaultBaseUrl} className="h-9 rounded-lg border border-strong bg-bg px-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent" />
                  </label>
                )}
              </div>
            )}

            <div className="mt-1 flex items-center justify-between">
              <button className="btn small" onClick={() => setStage(0)}>← Back</button>
              <button
                className="btn small primary"
                disabled={keyLooksShort || testing}
                onClick={() => { setStage(2); }}
                data-testid="credentials-next"
              >
                Next: choose a model →
              </button>
            </div>
          </div>
        )}

        {stage === 2 && (
          <div className="mt-3 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-ui font-medium">Default model for this provider</span>
              <ModelSelector
                models={models}
                value={modelId}
                onChange={(id, label) => { setModelId(id); setModelLabel(label); }}
                placeholder={models.length === 0 ? 'Enter a model ID (custom endpoint)' : 'Choose a model…'}
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                className="btn small"
                disabled={testing || !modelId.trim()}
                onClick={() => void runTest()}
                data-testid="test-connection-btn"
              >
                {testing ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <span className="text-xs text-dim">
                Makes one tiny real API call to verify the key, the endpoint, and that the model exists.
              </span>
            </div>

            {testResult?.ok && (
              <div className="ok-banner" role="status" data-testid="test-ok">
                ✓ Credentials valid · Provider reachable · Model available
              </div>
            )}
            {testResult && !testResult.ok && (
              <div className="error-banner" role="alert" data-testid="test-error">
                {friendlyByokError(testResult.error)}
              </div>
            )}
            {formErr && <div className="error-banner" role="alert">{friendlyByokError(formErr)}</div>}

            <div className="mt-1 flex items-center justify-between">
              <button className="btn small" onClick={() => setStage(1)} disabled={saving}>← Back</button>
              <button
                className="btn small primary"
                disabled={saving || !modelId.trim() || !testResult?.ok}
                onClick={() => void save()}
                data-testid="save-provider-btn"
                title={testResult?.ok ? 'Save and connect' : 'Test the connection first'}
              >
                {saving ? 'Saving…' : 'Save & connect'}
              </button>
            </div>
          </div>
        )}

      </DialogContent>
    </Dialog>
  );
}
