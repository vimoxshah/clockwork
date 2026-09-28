/**
 * The worker side of the pairing claim, in the app (Settings › Workers).
 *
 * Two real daemons: A is the primary and listens on a loopback port; B is the
 * worker and reaches A with a real fetch — the same hop the app makes.
 *
 * Trust properties asserted here, not described:
 * - /worker/identity and /worker/claim take user auth (401 anonymous)
 * - identity is read-only: opening Settings never mints or rotates a key
 * - the claim signs with B's own worker-key; the private key never appears
 *   in a response or in B's audit log
 * - the primary's refusals (not_found, unknown_nonce, …) reach the UI
 *   verbatim, with the primary's status
 * - a claim earns no token: approve on A is still the only way to get one
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

interface Daemon {
  db: DB;
  dir: string;
  app: FastifyInstance;
  token: string;
}

async function daemon(prefix: string): Promise<Daemon> {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  const rm = new RunManager({
    db,
    clock: new FakeClock(Date.now()),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock: new FakeClock(Date.now()), enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  await built.app.ready();
  return { db, dir, app: built.app, token: built.token };
}

describe('in-app pairing claim (worker → primary)', () => {
  let a: Daemon;
  let b: Daemon;
  let primaryUrl: string;
  const as = (d: Daemon, o: any) => ({ ...o, headers: { authorization: `Bearer ${d.token}` } });

  beforeAll(async () => {
    a = await daemon('cw-claim-a-');
    b = await daemon('cw-claim-b-');
    primaryUrl = await a.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await a.app.close();
    await b.app.close();
    a.db.close();
    b.db.close();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });

  it('identity and claim require user auth', async () => {
    expect((await b.app.inject({ method: 'GET', url: '/worker/identity' })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce: 'ab' } })).statusCode).toBe(401);
  });

  it('identity is null before a key exists, and reading it mints nothing', async () => {
    const res = await b.app.inject(as(b, { method: 'GET', url: '/worker/identity' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKeyHex: null });
    expect(existsSync(path.join(b.dir, 'worker-key'))).toBe(false);
  });

  it('claim without an identity refuses before any network hop', async () => {
    const res = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce: 'aa'.repeat(16) } }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_identity');
  });

  it('claim validates the URL and the nonce locally', async () => {
    await b.app.inject(as(b, { method: 'POST', url: '/worker/keygen', payload: {} }));
    const badUrl = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl: 'ftp://x', nonce: 'aa'.repeat(16) } }));
    expect(badUrl.statusCode).toBe(422);
    const badNonce = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce: 'not hex!' } }));
    expect(badNonce.statusCode).toBe(422);
  });

  it('relays the primary refusal when no pairing was started for this key', async () => {
    const res = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce: 'aa'.repeat(16) } }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('not_found');
    expect(res.json().message).toMatch(/operator starts it on the primary/);
  });

  it('says so plainly when the primary is unreachable', async () => {
    const res = await b.app.inject(
      as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl: 'http://127.0.0.1:9', nonce: 'aa'.repeat(16) } }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('unreachable');
  });

  it('full ceremony: start on A, claim on B, approve on A, join on B', async () => {
    const id = (await b.app.inject(as(b, { method: 'GET', url: '/worker/identity' }))).json();
    expect(id.publicKeyHex).toMatch(/^[0-9a-f]{64,}$/);
    const init = await a.app.inject(as(a, { method: 'POST', url: '/workers/pairing/init', payload: { name: 'studio-mini', pubkeyHex: id.publicKeyHex } }));
    expect(init.statusCode).toBe(201);
    const { workerId, nonce } = init.json();

    // A wrong nonce against a started pairing is the primary's unknown_nonce.
    const wrong = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce: 'bb'.repeat(16) } }));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toBe('unknown_nonce');

    // Approve before the claim still refuses — signature unverified.
    expect((await a.app.inject(as(a, { method: 'POST', url: `/workers/${workerId}/approve`, payload: {} }))).statusCode).toBe(422);

    // Pasted nonces carry whitespace; the trailing slash on the URL too.
    const claim = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl: `${primaryUrl}/`, nonce: `  ${nonce}\n` } }));
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ ok: true, workerId, primaryHost: new URL(primaryUrl).host });
    const priv = readFileSync(path.join(b.dir, 'worker-key'), 'utf8').trim();
    expect(JSON.stringify(claim.json())).not.toContain(priv);
    expect(claim.json().token).toBeUndefined(); // a claim earns nothing
    const auditRows = JSON.stringify(b.db.prepare('SELECT * FROM audit_log').all());
    expect(auditRows).toContain('worker.claim_sent');
    expect(auditRows).not.toContain(priv);
    expect(auditRows).not.toContain(nonce);

    // Nonces are single use: the replay is refused, verbatim from A.
    const replay = await b.app.inject(as(b, { method: 'POST', url: '/worker/claim', payload: { primaryUrl, nonce } }));
    expect(replay.statusCode).toBe(422);

    const ap = await a.app.inject(as(a, { method: 'POST', url: `/workers/${workerId}/approve`, payload: {} }));
    expect(ap.statusCode).toBe(200);
    const join = await b.app.inject(as(b, { method: 'POST', url: '/worker/join', payload: { primaryUrl, token: ap.json().token } }));
    expect(join.statusCode).toBe(200);
    // B's token resolves to the row A approved.
    const me = await fetch(`${primaryUrl}/workers/me`, { headers: { 'x-clockwork-worker': ap.json().token } });
    expect(((await me.json()) as any).id).toBe(workerId);
  });
});
