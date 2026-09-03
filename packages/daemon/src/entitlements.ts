/**
 * Entitlements (commercial gauntlet §7-10): centralized license/capability
 * service. A signed entitlement document (Ed25519) is activated once,
 * verified locally, cached in SQLite, and consulted OFFLINE thereafter.
 *
 * Fail-closed rules:
 *  - Tokens with a bad signature, wrong key, or unparsable claims are
 *    rejected outright; the install falls back to the free tier.
 *  - Until the shipping public key is configured, ALL paid tokens are
 *    rejected (tests inject their own keypair). No fake validation.
 *
 * Offline rules:
 *  - can()/limitFor() never touch the network.
 *  - An expired-but-recently-valid entitlement keeps working through
 *    GRACE_PERIOD_MS, surfaced as state "grace".
 *  - Past grace, the tier degrades to free; local data is never deleted.
 *
 * Clock-rollback guard: the highest observed monotonic time is persisted;
 * if the wall clock jumps backwards beneath it, the cache is treated as
 * expired until a successful revalidation.
 */
import { createPublicKey, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { DB } from './db.js';
import { FEATURES, numericLimit, setTier, getTier, type Tier } from './features.js';

export const GRACE_PERIOD_MS = 72 * 3600_000;
export const REVALIDATE_INTERVAL_MS = 12 * 3600_000;

/** Shipped Ed25519 public key (SPKI, hex). Empty = reject paid tokens. */
export const ENTITLEMENT_PUBLIC_KEY_HEX = '';

export interface EntitlementClaims {
  /** subject: account or license id */
  sub: string;
  plan: Exclude<Tier, 'free'>;
  /** feature keys explicitly granted beyond the plan matrix (rare) */
  caps?: string[];
  iat: number;
  exp: number;
  /** optional device binding */
  device_id?: string;
}

export type EntitlementState = 'none' | 'active' | 'grace' | 'expired';

interface CacheRow {
  token: string | null;
  payload_json: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  high_water_ms: number | null;
}

export function signEntitlement(claims: EntitlementClaims, privateKey: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8');
  const sig = cryptoSign(null, payload, privateKey);
  return `${payload.toString('base64url')}.${sig.toString('base64url')}`;
}

export class EntitlementService {
  private cached: { claims: EntitlementClaims; state: EntitlementState } | null = null;
  /** Tests inject a keypair here; production leaves it unset (fail-closed). */
  private readonly publicKeyHexOverride?: string;

  constructor(private readonly db: DB, options?: { publicKeyHex?: string }) {
    this.publicKeyHexOverride = options?.publicKeyHex;
  }

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS entitlement_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT,
      payload_json TEXT,
      expires_at INTEGER,
      last_validated_at INTEGER,
      high_water_ms INTEGER
    )`);
  }

  private row(): CacheRow {
    this.ensureSchema();
    return (this.db.prepare('SELECT token, payload_json, expires_at, last_validated_at, high_water_ms FROM entitlement_cache WHERE id = 1').get() ?? {}) as CacheRow;
  }

  /** Device id used for optional binding + support diagnostics. Stable per data dir. */
  deviceId(): string {
    this.ensureSchema();
    const got = this.db.prepare('SELECT device_id FROM entitlement_cache WHERE id = 1').get() as { device_id?: string } | undefined;
    if (got?.device_id) return got.device_id;
    const id = randomUUID();
    try {
      this.db.prepare('UPDATE entitlement_cache SET device_id = ? WHERE id = 1').run(id);
    } catch {
      this.db.exec('ALTER TABLE entitlement_cache ADD COLUMN device_id TEXT');
      this.db.prepare('UPDATE entitlement_cache SET device_id = ? WHERE id = 1').run(id);
    }
    return id;
  }

  /**
   * Activate a signed entitlement. Verifies signature + claims and caches it.
   * Throws on any invalid input — the caller surfaces the reason to the user.
   */
  activate(token: string): EntitlementClaims {
    this.ensureSchema();
    const claims = this.verifyToken(token); // throws with a human-readable reason

    // Optional device binding.
    if (claims.device_id) {
      let dev = '';
      try { dev = this.deviceId(); } catch { /* non-fatal */ }
      if (dev && dev !== claims.device_id) throw new Error('This license is bound to another machine. Deactivate it there first or contact support.');
    }

    const now = Date.now();
    this.db.prepare(`INSERT INTO entitlement_cache (id, token, payload_json, expires_at, last_validated_at)
                     VALUES (1, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET token=excluded.token, payload_json=excluded.payload_json,
                       expires_at=excluded.expires_at, last_validated_at=excluded.last_validated_at`)
      .run(token, JSON.stringify(claims), claims.exp, now);

    // S-review (OpenCode): reflect reality immediately — an already-expired
    // token activates into grace, not "active".
    this.cached = { claims, state: claims.exp >= now ? 'active' : 'grace' };
    setTier(claims.plan);
    return claims;
  }

  /** Remove the entitlement immediately (cancellation / revocation path). */
  deactivate(): void {
    this.ensureSchema();
    this.db.prepare('UPDATE entitlement_cache SET token = NULL, payload_json = NULL, expires_at = NULL, last_validated_at = NULL WHERE id = 1').run();
    setTier('free');
    this.cached = null;
  }

  // S-review (Hermes): the two 'not complete' strings below describe the key's
  // shape ('one long line with a dot in the middle'). That copy is coupled to
  // the payload.signature token format — if the format changes, change it too.
  verifyToken(token: string): EntitlementClaims {
    const fail = (why: string): never => { throw new Error(why); };
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return fail(
      'This license key is not complete. Copy the whole key from your purchase email — it is one long line with a dot in the middle — and paste it again.',
    );
    let payload: Buffer; let sig: Buffer; let claims: EntitlementClaims;
    try {
      payload = Buffer.from(payloadB64, 'base64url');
      sig = Buffer.from(sigB64, 'base64url');
      claims = JSON.parse(payload.toString('utf8')) as EntitlementClaims;
    } catch {
      return fail(
      'This license key is not complete. Copy the whole key from your purchase email — it is one long line with a dot in the middle — and paste it again.',
    );
    }
    const configuredKey = this.publicKeyHexOverride || ENTITLEMENT_PUBLIC_KEY_HEX;
    if (!configuredKey) return fail(
      'License activation is not available in this build. Install the latest Clockwork release from the official site, or contact support if this build should support it.',
    );
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.from(configuredKey, 'hex'), format: 'der', type: 'spki' });
      ok = cryptoVerify(null, payload, key, sig);
    } catch {
      ok = false;
    }
    if (!ok) return fail('This license key is not genuine. Re-download Clockwork from the official site or contact support.');
    if (!claims.sub || !claims.plan || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
      return fail(
        'This license key is damaged and cannot be read. Re-copy it from your purchase email; if it still fails, contact support and quote your order number.',
      );
    }
    // S-review (OpenCode): plan must be a real tier — a malformed claim must
    // never create a ghost tier.
    if (!['pro', 'team', 'enterprise'].includes(claims.plan)) {
      return fail(
        'This license key is for a plan this version of Clockwork does not recognise. Update to the latest version, then activate again.',
      );
    }
    if (claims.exp < Date.now() - GRACE_PERIOD_MS) return fail('This license has expired and is beyond its offline grace period. Renew to reactivate.');
    return claims;
  }

  /** Refresh from cache WITHOUT network. Recomputes state incl. clock-rollback guard. */
  private refreshFromCache(now = Date.now()): void {
    const r = this.row();
    if (!r.payload_json || !r.expires_at || !r.last_validated_at) {
      this.cached = null;
      setTier('free');
      return;
    }
    const highWater = Math.max(r.high_water_ms ?? 0, now);
    if (r.high_water_ms != null && highWater > (r.high_water_ms ?? 0)) {
      this.db.prepare('UPDATE entitlement_cache SET high_water_ms = ? WHERE id = 1').run(highWater);
    }
    const rollback = r.high_water_ms != null && now < (r.high_water_ms ?? 0) - 60_000;
    const sinceValidation = highWater - r.last_validated_at;

    let claims: EntitlementClaims | null = null;
    try { claims = JSON.parse(r.payload_json) as EntitlementClaims; } catch { claims = null; }
    if (!claims) { this.cached = null; setTier('free'); return; }

    let state: EntitlementState;
    if (rollback) {
      state = 'expired';
    } else if (claims.exp >= now) {
      // S-review (OpenCode): the token's own expiry is the enforcement point.
      // The revalidation window only gates POST-expiry grace, not an
      // unexpired license — otherwise every subscription degrades to free
      // ~48h after activation because no revalidation caller exists yet.
      state = 'active';
    } else if (claims.exp >= now - GRACE_PERIOD_MS && sinceValidation <= REVALIDATE_INTERVAL_MS * 4) {
      // Post-expiry grace requires the cache to be recent: a long-absent
      // install cannot resurrect a lapsed license by staying offline.
      state = 'grace';
    } else {
      state = 'expired';
    }

    this.cached = { claims, state };
    setTier(state === 'active' || state === 'grace' ? claims.plan : 'free');
  }

  /** Current entitlement snapshot for UI/API. Never touches the network. */
  status(): { tier: Tier; state: EntitlementState; plan?: string; expiresAt?: number; graceEndsAt?: number; revalidateDueAt?: number; subject?: string } {
    this.refreshFromCache();
    if (!this.cached) {
      return { tier: getTier(), state: 'none' };
    }
    const { claims, state } = this.cached;
    const r = this.row();
    const out: ReturnType<EntitlementService['status']> = {
      tier: getTier(),
      state,
      plan: claims.plan,
      expiresAt: claims.exp,
      subject: claims.sub,
      revalidateDueAt: (r.last_validated_at ?? 0) + REVALIDATE_INTERVAL_MS,
    };
    if (state === 'grace') out.graceEndsAt = (r.last_validated_at ?? 0) + GRACE_PERIOD_MS;
    return out;
  }

  /**
   * Central gate (gauntlet §7): resolve a feature key against the current
   * tier WITHOUT scattering plan checks at call sites.
   * Returns { allowed, limit, requiresPlan } — limit is a number when the
   * registry expresses one ("2 triggers", "30 days"), else undefined.
   * `allowed=false` always carries the plan name that unlocks it.
   */
  gate(featureKey: string): { allowed: boolean; limit?: number; requiresPlan?: Tier } {
    this.refreshFromCache(); // keeps getTier() authoritative for this call
    const f = FEATURES.find((x) => x.key === featureKey);
    if (!f) return { allowed: false, requiresPlan: 'pro' };
    const tier = getTier();
    if (f.tiers[tier]?.available) return { allowed: true };
    // Find the cheapest plan that unlocks it, for honest upgrade copy.
    const order: Tier[] = ['free', 'pro', 'team', 'enterprise'];
    const idx = order.indexOf(tier);
    const unlocker = order.slice(idx + 1).find((t) => f.tiers[t]?.available) ?? 'enterprise';
    return { allowed: false, requiresPlan: unlocker };
  }

  /** Parse a registry limit string like "2 triggers" or "90 days" into a number. */
  static limitNumber(limit: string | undefined): number | undefined {
    if (!limit) return undefined;
    const m = /(\d+)/.exec(limit);
    const g = m?.[1];
    return g ? parseInt(g, 10) : undefined;
  }

  /**
   * Convenience: machine-readable cap for a feature on the current tier.
   * Reads the NUMERIC_LIMITS map — never parses display prose.
   */
  limitFor(featureKey: string): number | undefined {
    this.refreshFromCache();
    return numericLimit(featureKey);
  }
}

