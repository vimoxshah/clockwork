/**
 * BYOK provider configuration store (ADR-027).
 *
 * Credentials are stored ONLY in the OS keychain (macOS `security` CLI),
 * never in SQLite, JSON, logs, or task payloads. The DB row keeps a
 * redacted hint for display ("••••9A2F") and metadata only.
 */
import { execFileSync } from 'node:child_process';
import { newId } from '@clockwork/shared';
import { ProviderConfig, type ByokKind, PROVIDER_KIND_META } from '@clockwork/shared';

const KEYCHAIN_SERVICE_PREFIX = 'clockwork-byok-';

export interface ByokStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { prepare: (sql: string) => { run: (...a: any[]) => unknown; get: (...a: any[]) => unknown; all: (...a: any[]) => any[] }; transaction?: (fn: () => void) => unknown };
}

interface ConfigRow {
  id: string;
  kind: string;
  label: string;
  base_url: string | null;
  auth: string;
  hint: string | null;
  env_var: string | null;
  default_model: string;
  model_label: string | null;
  is_default: number;
  created_at: number;
  last_validated_at: number | null;
  last_error: string | null;
}

function toConfig(r: ConfigRow): ProviderConfig {
  return {
    id: r.id,
    kind: r.kind as ByokKind,
    label: r.label,
    ...(r.base_url ? { base_url: r.base_url } : {}),
    auth: r.auth as 'keychain' | 'env',
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.env_var ? { env_var: r.env_var } : {}),
    default_model: r.default_model,
    ...(r.model_label ? { model_label: r.model_label } : {}),
    is_default: r.is_default === 1,
    created_at: r.created_at,
    last_validated_at: r.last_validated_at,
    last_error: r.last_error,
  };
}

function keychainService(id: string): string {
  return KEYCHAIN_SERVICE_PREFIX + id;
}

/** Store the credential in the macOS keychain; overwrites existing entry. */
export function keychainSet(id: string, secret: string): void {
  // -U updates in place if the service already exists.
  execFileSync('security', [
    'add-generic-password',
    '-s', keychainService(id),
    '-a', 'clockwork',
    '-l', 'Clockwork provider credential (' + id + ')',
    '-w', secret,
    '-U',
  ], { timeout: 10_000 });
}

/** Read the credential from the keychain. Throws if absent. */
export function keychainGet(id: string): string {
  return execFileSync('security', ['find-generic-password', '-s', keychainService(id), '-w'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
}

export function keychainDelete(id: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', keychainService(id)], { timeout: 10_000 });
  } catch {
    // already absent — fine
  }
}

/** Redact a secret to "••••last4" for display; never log or persist more. */
export function redact(secret: string): string {
  const tail = secret.slice(-4);
  return '••••' + tail;
}

/**
 * Live validation per provider kind. Makes a minimal real API call.
 * Returns undefined on success, an error message on failure.
 */
export async function validateProvider(kind: ByokKind, baseUrl: string, credential: string): Promise<string | undefined> {
  try {
    if (kind === 'anthropic') {
      const res = await fetch(baseUrl + '/v1/models', {
        headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
      return undefined;
    }
    // OpenAI-compatible shape covers openai/openrouter/google(v1beta/openai)/mistral/deepseek/xai/custom
    const res = await fetch(baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + credential },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
    return undefined;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 200);
  }
}

export class ByokStore {
  constructor(private readonly deps: ByokStoreDeps) {}

  private ensureSchema(): void {
    this.deps.db.prepare(`CREATE TABLE IF NOT EXISTS byok_configs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      base_url TEXT,
      auth TEXT NOT NULL DEFAULT 'keychain',
      hint TEXT,
      env_var TEXT,
      default_model TEXT NOT NULL,
      model_label TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_validated_at INTEGER,
      last_error TEXT
    )`).run();
    // Installations predating migration 0007.
    const cols = this.deps.db.prepare(`PRAGMA table_info(byok_configs)`).all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'model_label')) {
      this.deps.db.prepare('ALTER TABLE byok_configs ADD COLUMN model_label TEXT').run();
    }
    if (!cols.some((c) => c.name === 'is_default')) {
      this.deps.db.prepare('ALTER TABLE byok_configs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0').run();
    }
  }

  list(): ProviderConfig[] {
    this.ensureSchema();
    const rows = this.deps.db.prepare('SELECT * FROM byok_configs ORDER BY is_default DESC, created_at').all() as unknown as ConfigRow[];
    return rows.map(toConfig);
  }

  /** The user-chosen default config, or undefined when none is set. */
  getDefault(): ProviderConfig | undefined {
    this.ensureSchema();
    const r = this.deps.db.prepare('SELECT * FROM byok_configs WHERE is_default=1 LIMIT 1').get() as unknown as ConfigRow | undefined;
    return r ? toConfig(r) : undefined;
  }

  /** Set the default config; clears the flag on all others (transactional). */
  setDefault(id: string): void {
    this.ensureSchema();
    if (!this.get(id)) throw new Error('config not found');
    this.deps.db.transaction?.(() => {
      this.deps.db.prepare('UPDATE byok_configs SET is_default=0 WHERE is_default=1').run();
      this.deps.db.prepare('UPDATE byok_configs SET is_default=1 WHERE id=?').run(id);
    });
    if (!this.deps.db.transaction) {
      // Fallback when no transactional handle: order still leaves default set.
      this.deps.db.prepare('UPDATE byok_configs SET is_default=0 WHERE is_default=1').run();
      this.deps.db.prepare('UPDATE byok_configs SET is_default=1 WHERE id=?').run(id);
    }
  }

  get(id: string): ProviderConfig | undefined {
    this.ensureSchema();
    const r = this.deps.db.prepare('SELECT * FROM byok_configs WHERE id=?').get(id) as unknown as ConfigRow | undefined;
    return r ? toConfig(r) : undefined;
  }

  create(input: {
    kind: ByokKind;
    label?: string;
    baseUrl?: string;
    auth: 'keychain' | 'env';
    secret?: string;
    envVar?: string;
    defaultModel: string;
    /** cached display name for defaultModel ("Claude Sonnet"); id stays authoritative */
    modelLabel?: string;
  }): ProviderConfig {
    this.ensureSchema();
    const id = newId();
    let hint: string | null = null;
    if (input.auth === 'keychain') {
      if (!input.secret || input.secret.length < 8) throw new Error('credential required (min 8 chars)');
      keychainSet(id, input.secret);
      hint = redact(input.secret);
    } else {
      if (!input.envVar || !/^[A-Z_][A-Z0-9_]*$/.test(input.envVar)) throw new Error('valid env_var required');
    }
    const now = Date.now();
    const isFirst = (this.deps.db.prepare('SELECT COUNT(*) AS n FROM byok_configs').get() as unknown as { n: number }).n === 0;
    this.deps.db.prepare(
      'INSERT INTO byok_configs (id, kind, label, base_url, auth, hint, env_var, default_model, model_label, is_default, created_at, last_validated_at, last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      id,
      input.kind,
      input.label ?? PROVIDER_KIND_META[input.kind].label,
      input.baseUrl ?? null,
      input.auth,
      hint,
      input.envVar ?? null,
      input.defaultModel,
      input.modelLabel ?? null,
      isFirst ? 1 : 0,
      now,
      null,
      null,
    );
    return this.get(id) as ProviderConfig;
  }

  /** Rotate the stored credential (keychain mode). Returns new hint. */
  rotateKey(id: string, secret: string): string {
    const cfg = this.get(id);
    if (!cfg) throw new Error('config not found');
    if (cfg.auth !== 'keychain') throw new Error('not a keychain config');
    if (!secret || secret.length < 8) throw new Error('credential too short');
    keychainSet(id, secret);
    const hint = redact(secret);
    this.deps.db.prepare('UPDATE byok_configs SET hint=?, last_error=NULL WHERE id=?').run(hint, id);
    return hint;
  }

  markValidated(id: string, err: string | null): void {
    this.ensureSchema();
    this.deps.db.prepare('UPDATE byok_configs SET last_validated_at=?, last_error=? WHERE id=?')
      .run(err ? null : Date.now(), err, id);
  }

  delete(id: string): boolean {
    this.ensureSchema();
    keychainDelete(id); // no-op when env mode
    this.deps.db.prepare('DELETE FROM byok_configs WHERE id=?').run(id);
    return true;
  }

  /**
   * Resolve the runtime credential for a config. Called at run start only.
   * Throws if the credential cannot be located — never returns a placeholder.
   */
  resolveCredential(cfg: ProviderConfig): string {
    if (cfg.auth === 'env' && cfg.env_var) {
      const v = process.env[cfg.env_var];
      if (!v) throw new Error(`env var ${cfg.env_var} is not set`);
      return v;
    }
    return keychainGet(cfg.id);
  }

  baseUrlFor(cfg: ProviderConfig): string {
    return cfg.base_url ?? PROVIDER_KIND_META[cfg.kind].defaultBaseUrl;
  }
}
