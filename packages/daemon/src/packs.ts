/**
 * Template packs (P6): one file installs a team's whole workflow.
 *
 * A pack is JSON, inspectable before anything executes:
 *
 *   { schema: 'clockwork.pack.v1',
 *     manifest: { name, version, publisher, description?, minClockworkVersion? },
 *     templates: [ clockwork.template.v1, ... ],
 *     signatures: [{ keyId, signature }] }
 *
 * Trust without a central registry (there is no Clockwork cloud to host
 * one): detached ed25519 over canonical JSON, same DER-hex key convention
 * as worker pairing. Trust is TOFU with a fingerprint shown: the first
 * install of an unknown key requires explicit consent (`trustKey`), pins the
 * key, and every later install verifies — a changed key for a known
 * publisher refuses loudly instead of updating quietly.
 *
 * Install reuses the single-template import path exactly (same preview,
 * same red-flag refusal, same disabled-on-arrival, same IMPORT_GRANT
 * budgets): a pack cannot grant what a file cannot.
 */
import { createHash, sign, verify, createPublicKey, createPrivateKey, type KeyLike } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

export const PACK_SCHEMA = 'clockwork.pack.v1';
export const PACK_MAX_BYTES = 2 * 1024 * 1024;

export interface PackManifest {
  name: string;
  version: string;
  publisher: string;
  description?: string;
  homepage?: string;
  minClockworkVersion?: string;
}

export interface PackSignature {
  keyId: string;
  /** Publisher DER-hex ed25519 pubkey, carried so first installs can trust
   *  explicitly (TOFU). Must hash to keyId — a mismatched pair refuses. */
  pubkeyHex: string;
  signature: string;
}

export interface PackFile {
  schema: string;
  manifest: PackManifest;
  templates: unknown[];
  signatures: PackSignature[];
}

/** Canonical JSON: sorted object keys, recursive; arrays keep order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Key id = first 16 hex of sha256(pubkey DER hex). Short, stable, shown. */
export function keyIdOf(pubkeyHex: string): string {
  return createHash('sha256').update(pubkeyHex.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function packBytes(pack: PackFile): Buffer {
  return Buffer.from(stableStringify({ manifest: pack.manifest, templates: pack.templates }), 'utf8');
}

/** Publisher-side: sign canonical bytes with a pkcs8 DER-hex private key. */
export function signPack(privHex: string, manifest: PackManifest, templates: unknown[]): PackSignature {
  const priv = createPrivateKey({ key: Buffer.from(privHex.trim(), 'hex'), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  const pubHex = pub.export({ format: 'der', type: 'spki' }).toString('hex');
  const sig = sign(null, packBytes({ schema: PACK_SCHEMA, manifest, templates, signatures: [] }), priv);
  return { keyId: keyIdOf(pubHex), pubkeyHex: pubHex, signature: sig.toString('hex') };
}

function pubKeyOf(pubkeyHex: string): KeyLike | null {
  try {
    const k = createPublicKey({ key: Buffer.from(pubkeyHex.trim(), 'hex'), format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ed25519') return null;
    return k;
  } catch {
    return null;
  }
}

export type PackVerify =
  | { ok: true; keyId: string }
  | { ok: false; reason: 'bad_shape' | 'unknown_key' | 'key_changed' | 'bad_signature' | 'incompatible'; message: string; keyId?: string; pubkeyHex?: string };

function cmpVersions(a: string, b: string): number | null {
  // Strict x.y.z: Number('') === 0 would otherwise accept '1..2' as 1.0.2.
  if (!/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return (pa[i]! < pb[i]! ? -1 : 1);
  }
  return 0;
}

/** A pack template entry must be shaped like a template before anything
 *  reads its fields — securityPreview assumes an object, and a null/number
 *  entry would 500 instead of refusing. */
export function assertTemplateShape(t: unknown): t is { name?: unknown; prompt?: unknown; permissionMode?: unknown } {
  return !!t && typeof t === 'object' && !Array.isArray(t);
}

/**
 * Verify structure, version compatibility, and at least one signature from a
 * trusted key. Unknown keys are NOT failures to argue with — they return
 * unknown_key with the fingerprint so the caller can ask a human. A known
 * keyId presenting a DIFFERENT pubkey is key_changed: the publisher rotated
 * (or someone swaps keys) and quiet re-trust is exactly what TOFU forbids.
 */
export function verifyPack(
  pack: PackFile,
  trusted: Map<string, TrustedKeyRecord>,
  daemonVersion: string,
): PackVerify {
  if (!pack || pack.schema !== PACK_SCHEMA || typeof pack.manifest?.name !== 'string' || typeof pack.manifest?.version !== 'string' || !Array.isArray(pack.templates) || !Array.isArray(pack.signatures)) {
    return { ok: false, reason: 'bad_shape', message: 'Not a clockwork.pack.v1 file — check schema, manifest.name/version, templates[] and signatures[].' };
  }
  if (cmpVersions(pack.manifest.version, '0.0.0') === null) {
    return { ok: false, reason: 'bad_shape', message: `Pack version "${pack.manifest.version}" is not x.y.z.` };
  }
  if (pack.manifest.minClockworkVersion) {
    const c = cmpVersions(daemonVersion, pack.manifest.minClockworkVersion);
    if (c === null) return { ok: false, reason: 'bad_shape', message: `Pack minClockworkVersion "${pack.manifest.minClockworkVersion}" is not x.y.z.` };
    if (c < 0) {
      return { ok: false, reason: 'incompatible', message: `Pack needs Clockwork ${pack.manifest.minClockworkVersion}+ (this daemon is ${daemonVersion}).` };
    }
  }
  if (pack.templates.length === 0) {
    return { ok: false, reason: 'bad_shape', message: 'Pack carries no templates.' };
  }
  const bytes = packBytes(pack);
  let unknown: PackSignature | null = null;
  for (const sig of pack.signatures) {
    if (!sig || typeof sig !== 'object') continue;
    if (typeof sig.keyId !== 'string' || typeof sig.pubkeyHex !== 'string' || typeof sig.signature !== 'string') continue;
    // The pair must be self-consistent first: a keyId naming one key with
    // another key's bytes is malformed, not merely untrusted.
    if (keyIdOf(sig.pubkeyHex) !== sig.keyId) continue;
    const known = trusted.get(sig.keyId);
    if (!known) {
      unknown = unknown ?? sig;
      continue;
    }
    if (known.pubkeyHex.trim().toLowerCase() !== sig.pubkeyHex.trim().toLowerCase()) {
      return { ok: false, reason: 'key_changed', message: `Known publisher key ${sig.keyId} arrived with different key bytes — rotation requires explicit re-trust, never quiet update.` };
    }
    const key = pubKeyOf(sig.pubkeyHex);
    if (!key) continue;
    try {
      if (verify(null, bytes, key, Buffer.from(sig.signature, 'hex'))) return { ok: true, keyId: sig.keyId };
    } catch {
      continue;
    }
  }
  if (unknown) {
    return { ok: false, reason: 'unknown_key', message: `Signed by unknown key ${unknown.keyId} — first install requires explicit trust.`, keyId: unknown.keyId, pubkeyHex: unknown.pubkeyHex };
  }
  return { ok: false, reason: 'bad_signature', message: 'No signature verifies against a trusted key — refused.' };
}

/** Fetch a pack over https only, size-capped, timed out. Files stay local. */
export async function fetchPack(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<{ ok: true; pack: PackFile } | { ok: false; reason: string; message: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'bad_url', message: 'Not a parseable URL.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'bad_url', message: 'Packs fetch over https only — plain http and file URLs are refused.' };
  }
  const deadline = Date.now() + timeoutMs;
  // Redirects are followed by hand, max 3 hops, every hop re-checked for
  // https: fetch's default follower would walk a 302 to http:// (or a
  // metadata address) without asking, and credentials must never follow.
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; hop <= 3; hop++) {
    let next: URL;
    try {
      next = new URL(current);
    } catch {
      return { ok: false, reason: 'bad_url', message: 'Redirect target does not parse.' };
    }
    if (next.protocol !== 'https:') {
      return { ok: false, reason: 'bad_url', message: 'A redirect left https — refused.' };
    }
    try {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, reason: 'network', message: 'Pack fetch timed out.' };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), left);
      try {
        res = await fetchImpl(current, { signal: ctrl.signal, redirect: 'manual' });
      } finally {
        clearTimeout(t);
      }
    } catch {
      return { ok: false, reason: 'network', message: 'Could not fetch the pack URL.' };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === 3) {
        return { ok: false, reason: 'network', message: 'Too many redirects fetching the pack.' };
      }
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok) return { ok: false, reason: 'network', message: `Pack URL answered HTTP ${res?.status ?? 'unknown'}.` };
  // Streamed with a running cap: buffering the whole body first lets a
  // chunked response OOM the daemon before the cap is ever checked, and the
  // deadline covers the body too (a slow drip is a hang with a good excuse).
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, reason: 'network', message: 'Pack response has no body.' };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    if (Date.now() > deadline) {
      try {
        await reader.cancel();
      } catch {}
      return { ok: false, reason: 'network', message: 'Pack fetch timed out mid-body.' };
    }
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > PACK_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {}
      return { ok: false, reason: 'too_large', message: `Pack exceeds the ${(PACK_MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap.` };
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_shape', message: 'Pack URL did not return JSON.' };
  }
  if (nestDepth(parsed) > 50) {
    return { ok: false, reason: 'bad_shape', message: 'Pack nests too deeply to be a pack.' };
  }
  return { ok: true, pack: parsed as PackFile };
}

/** Nesting depth of parsed JSON (objects/arrays); primitives are 0. */
function nestDepth(v: unknown, seen = 0): number {
  if (v === null || typeof v !== 'object' || seen > 50) return seen;
  const kids: unknown[] = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  return kids.reduce<number>((m, x) => Math.max(m, nestDepth(x, seen + 1)), seen);
}

export interface TrustedKeyRecord {
  pubkeyHex: string;
  publisher: string;
  trustedAt: number;
}

/** TOFU trust store: ~/.clockwork/trusted-pack-keys.json, 0600, keyed by keyId. */
export function trustFile(dataDir: string): string {
  return `${dataDir}/trusted-pack-keys.json`;
}

export function loadTrustedKeys(dataDir: string): Map<string, TrustedKeyRecord> {
  const out = new Map<string, TrustedKeyRecord>();
  try {
    if (!existsSync(trustFile(dataDir))) return out;
    const raw = JSON.parse(readFileSync(trustFile(dataDir), 'utf8')) as Record<string, TrustedKeyRecord>;
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.pubkeyHex === 'string') out.set(k, v);
      }
    }
  } catch {}
  return out;
}

export function pinTrustedKey(dataDir: string, keyId: string, pubkeyHex: string, publisher: string): void {
  let current: Record<string, TrustedKeyRecord> = {};
  try {
    if (existsSync(trustFile(dataDir))) {
      const parsed = JSON.parse(readFileSync(trustFile(dataDir), 'utf8'));
      if (parsed && typeof parsed === 'object') current = parsed;
    }
  } catch {}
  current[keyId] = { pubkeyHex, publisher, trustedAt: Date.now() };
  writeFileSync(trustFile(dataDir), JSON.stringify(current, null, 2), { mode: 0o600 });
  chmodSync(trustFile(dataDir), 0o600); // writeFileSync mode is ignored when the file exists
}

/** x.y.z compare for pack versions. Null when either side is not x.y.z. */
export function cmpPackVersions(a: string, b: string): number | null {
  return cmpVersions(a, b);
}

/**
 * Resolve a pack from a preview/install body: inline object wins, else the
 * URL is fetched (https only, capped). Never both, never neither.
 */
export async function resolvePackSource(
  body: { pack?: unknown; url?: unknown },
  _dataDir: string,
): Promise<{ ok: true; pack: PackFile } | { ok: false; reason: string; message: string }> {
  if (body.pack !== undefined && body.pack !== null) {
    if (typeof body.pack !== 'object') {
      return { ok: false, reason: 'bad_shape', message: 'pack must be a pack object.' };
    }
    return { ok: true, pack: body.pack as PackFile };
  }
  if (typeof body.url === 'string' && body.url) {
    const f = await fetchPack(body.url);
    if (!f.ok) return f;
    return { ok: true, pack: f.pack };
  }
  return { ok: false, reason: 'bad_shape', message: 'Provide a pack object or a pack URL.' };
}
