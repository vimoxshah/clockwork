/**
 * EntitlementService (commercial gauntlet §7-10): signature verification is
 * fail-closed; cache drives offline state transitions; clock rollback degrades.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from '../src/db.js';
import {
  EntitlementService,
  signEntitlement,
  ENTITLEMENT_PUBLIC_KEY_HEX,
} from '../src/entitlements.js';

// Tests run against a stub of the shipped-key constant via direct verifyToken
// calls; the service reads the constant at call time, so we exercise the
// no-configured-key rejection path here and full crypto in integration below.
let db: DB;

beforeAll(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-entl-'));
  db = openDatabase(dir).db;
});

describe('EntitlementService — fail-closed baseline', () => {
  it('starts with tier none and free', () => {
    const svc = new EntitlementService(db);
    const s = svc.status();
    expect(s.state).toBe('none');
    expect(s.tier).toBe('free');
  });

  it('rejects malformed tokens with human-readable errors', () => {
    const svc = new EntitlementService(db);
    expect(() => svc.activate('not-a-license')).toThrow(/malformed/i);
    expect(() => svc.activate('a.b.c')).toThrow(/malformed/i);
  });

  it('rejects ANY paid token while no public key is configured (no fake validation)', async () => {
    // Generate a real keypair and sign honestly — must STILL be rejected
    // because the shipping build has no public key configured.
    expect(ENTITLEMENT_PUBLIC_KEY_HEX).toBe('');
    const { privateKey } = generateKeyPairSync('ed25519');
    const secret = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = signEntitlement(
      { sub: 'acc_1', plan: 'pro', iat: Date.now(), exp: Date.now() + 30 * 86_400_000 },
      secret,
    );
    const svc = new EntitlementService(db);
    expect(() => svc.activate(token)).toThrow(/not yet enabled/i);
    // And tier stays free.
    expect(svc.status().tier).toBe('free');
  });
});

describe('EntitlementService — verified-key lifecycle', () => {
  const DAY = 86_400_000;
  let db2: DB;
  let publicKeyHex: string;
  let privateKeyPem: string;
  let svc: EntitlementService;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-entl2-'));
    db2 = openDatabase(dir).db;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    svc = new EntitlementService(db2, { publicKeyHex });
  });

  it('activates a genuine token and lifts the tier', () => {
    const token = signEntitlement(
      { sub: 'acc_pro', plan: 'pro', iat: Date.now(), exp: Date.now() + 30 * DAY },
      privateKeyPem,
    );
    const claims = svc.activate(token);
    expect(claims.plan).toBe('pro');
    const s = svc.status();
    expect(s.state).toBe('active');
    expect(s.tier).toBe('pro');
    expect(s.subject).toBe('acc_pro');
  });

  it('rejects tokens signed by the wrong key as not genuine', () => {
    const { privateKey: other } = generateKeyPairSync('ed25519');
    const forged = signEntitlement(
      { sub: 'attacker', plan: 'enterprise', iat: Date.now(), exp: Date.now() + DAY },
      other.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    expect(() => svc.activate(forged)).toThrow(/not genuine/i);
    // Prior good entitlement still governs.
    expect(svc.status().tier).toBe('pro');
  });

  it('keeps working in grace after expiry, then degrades to free', () => {
    const graceToken = signEntitlement(
      { sub: 'acc_grace', plan: 'pro', iat: Date.now() - 2 * DAY, exp: Date.now() - 3600_000 },
      privateKeyPem,
    );
    svc.activate(graceToken);
    let s = svc.status();
    expect(s.state).toBe('grace');
    expect(s.tier).toBe('pro');
    expect(s.graceEndsAt).toBeGreaterThan(Date.now());

    // Beyond grace: verification itself refuses.
    const dead = signEntitlement(
      { sub: 'acc_dead', plan: 'pro', iat: Date.now() - 30 * DAY, exp: Date.now() - 4 * DAY },
      privateKeyPem,
    );
    expect(() => svc.activate(dead)).toThrow(/grace/i);

    // Cache untouched too long (missed revalidations) degrades even if unexpired.
    db2.prepare('UPDATE entitlement_cache SET last_validated_at = ? WHERE id = 1')
      .run(Date.now() - 30 * DAY);
    s = svc.status();
    expect(s.state).toBe('expired');
    expect(s.tier).toBe('free');
  });

  it('degrades on clock rollback instead of extending the license', () => {
    const token = signEntitlement(
      { sub: 'acc_rb', plan: 'team', iat: Date.now(), exp: Date.now() + DAY },
      privateKeyPem,
    );
    svc.activate(token);
    expect(svc.status().state).toBe('active');

    // Attacker rolls the wall clock backwards: high-water mark catches it.
    db2.prepare('UPDATE entitlement_cache SET high_water_ms = ? WHERE id = 1')
      .run(Date.now() + 5 * DAY);
    const s = svc.status();
    expect(s.state).toBe('expired');
    expect(s.tier).toBe('free');
  });

  it('deactivation returns to free immediately', () => {
    svc.deactivate();
    const s = svc.status();
    expect(s.state).toBe('none');
    expect(s.tier).toBe('free');
  });
});

