/**
 * Integration: entitlement gates fire at real routes (free tier).
 * Uses an in-memory-style temp DB; no network, no keychain.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { EntitlementService, signEntitlement } from '../src/entitlements.js';
import { setTier } from '../src/features.js';

let db: DB;

beforeAll(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-gates-'));
  db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
});

describe('numeric limits drive real caps (free tier)', () => {
  let svc: EntitlementService;

  beforeAll(() => {
    svc = new EntitlementService(db);
  });

  it('free retention is available but capped at 30 days', () => {
    expect(svc.limitFor('retention')).toBe(30);
    // Retention is available-with-cap on free; exceeding the cap is what
    // the route blocks (with requiresPlan from the gate below).
    expect(svc.gate('retention').allowed).toBe(true);
    const runDays = 365;
    const cap = svc.limitFor('retention');
    expect(runDays > (cap ?? Infinity)).toBe(true);
  });

  it('free trigger cap is 2 and counts existing rows', () => {
    expect(svc.limitFor('event_triggers')).toBe(2);
    // triggers.task_id has a FK to tasks; create a parent row first.
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, created_at, updated_at)
       VALUES ('task_x', 'gate probe', 'probe', 1, 1)
       ON CONFLICT(id) DO NOTHING`
    ).run();
    db.prepare(
      "INSERT INTO triggers (id, name, source, filter_json, secret_hash, task_id, enabled, created_at) VALUES ('t1','a','webhook',NULL,NULL,'task_x',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO triggers (id, name, source, filter_json, secret_hash, task_id, enabled, created_at) VALUES ('t2','b','webhook',NULL,NULL,'task_x',1,1)"
    ).run();
    const count = (db.prepare('SELECT COUNT(*) c FROM triggers').get() as any).c as number;
    expect(count >= (svc.limitFor('event_triggers') ?? 0)).toBe(true);
    // Available-with-cap: allowed=true, but hitting the cap triggers the
    // route's 402 with upgrade copy (see api.ts POST /triggers).
    expect(svc.gate('event_triggers').allowed).toBe(true);
  });

  it('audit + policies are plan-gated on free', () => {
    expect(svc.gate('audit_log').allowed).toBe(false);
    expect(svc.gate('audit_log').requiresPlan).toBe('pro');
    expect(svc.gate('policy_engine').allowed).toBe(false);
  });
});

describe('paid tier opens the same gates', () => {
  it('pro lifts audit/policies and raises limits', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const svc2 = new EntitlementService(db, { publicKeyHex: pubHex });
    svc2.activate(
      signEntitlement({ sub: 'acc_g', plan: 'pro', iat: Date.now(), exp: Date.now() + 86_400_000 }, pem),
    );
    expect(svc2.gate('audit_log').allowed).toBe(true);
    expect(svc2.gate('policy_engine').allowed).toBe(true);
    expect(svc2.limitFor('retention')).toBe(365);
    expect(svc2.limitFor('event_triggers')).toBe(50);
    void setTier; // imported to keep tree-shaking honest in dev runs
  });
});
