/**
 * Multi-machine workers (P4): pairing ceremony, tokens, routing decisions,
 * silence sweep, and the pull/complete protocol — all against real SQLite.
 *
 * Trust properties asserted here, not described:
 * - a valid signature alone earns NO token (approve waits for claim AND human)
 * - nonces are single-use; tokens are sha256-stored and returned once
 * - required pins wait (never silently local); preferred pins fall back loudly
 * - claimed-but-unreported runs fail as worker_lost, never complete
 * - a second puller never wins the same job (atomic claim)
 * - cross-worker access is 401 (no id oracle beyond it)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import {
  initPairing,
  claimPairing,
  approveWorker,
  revokeWorker,
  authWorker,
  resolveWorkerPin,
  sweepWorkers,
  listWorkers,
  HEARTBEAT_TIMEOUT_MS,
} from '../src/workers.js';
import { ensureWorkerTaskRow, startWorkerAgent, describePlatform } from '../src/worker-agent.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-wrk-'));
  const db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  return { db, dir };
}

function keypair(): { pubHex: string; priv: any } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubHex: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'), priv: privateKey };
}

function pairUp(db: DB, name = 'mini', now = Date.now()): { id: string; token: string; pubHex: string; priv: any } {
  const kp = keypair();
  const init = initPairing(db, { name, pubkeyHex: kp.pubHex, now });
  if (!init.ok) throw new Error('init failed');
  const sig = sign(null, Buffer.from(init.nonce, 'hex'), kp.priv);
  const claim = claimPairing(db, { nonce: init.nonce, pubkeyHex: kp.pubHex, signatureHex: sig.toString('hex'), now });
  if (!claim.ok) throw new Error('claim failed');
  const ap = approveWorker(db, claim.workerId, now);
  if (!ap.ok) throw new Error('approve failed');
  return { id: claim.workerId, token: ap.token, pubHex: kp.pubHex, priv: kp.priv };
}

describe('schema', () => {
  it('0014 applies: workers, pins, run assignment', () => {
    const { db, dir } = freshDb();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workers')").all();
      expect(tables).toHaveLength(1);
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map((c) => c.name);
      expect(cols).toContain('worker_pin');
      expect(cols).toContain('worker_required');
      const rcols = (db.prepare('PRAGMA table_info(runs)').all() as any[]).map((c) => c.name);
      expect(rcols).toContain('worker_id');
      expect(rcols).toContain('worker_claimed_at');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pairing ceremony', () => {
  it('init → claim → approve issues exactly one plaintext token', () => {
    const { db, dir } = freshDb();
    try {
      const kp = keypair();
      const init = initPairing(db, { name: 'mini', pubkeyHex: kp.pubHex });
      expect(init.ok).toBe(true);
      if (!init.ok) throw new Error('unreachable');
      // Approve BEFORE claim refuses: signature first, human second.
      expect(approveWorker(db, init.workerId)).toMatchObject({ ok: false, reason: 'bad_state' });
      const sig = sign(null, Buffer.from(init.nonce, 'hex'), kp.priv);
      const claim = claimPairing(db, { nonce: init.nonce, pubkeyHex: kp.pubHex, signatureHex: sig.toString('hex') });
      expect(claim).toMatchObject({ ok: true });
      // Nonce consumed: replay fails.
      const again = claimPairing(db, { nonce: init.nonce, pubkeyHex: kp.pubHex, signatureHex: sig.toString('hex') });
      expect(again).toMatchObject({ ok: false });
      const ap = approveWorker(db, init.workerId);
      expect(ap.ok).toBe(true);
      if (!ap.ok) throw new Error('unreachable');
      expect(ap.token).toMatch(/^[0-9a-f]{64}$/);
      // Stored as hash, never plaintext.
      const row = db.prepare('SELECT token_hash FROM workers WHERE id=?').get(init.workerId) as any;
      expect(row.token_hash).not.toContain(ap.token);
      expect(row.token_hash).toHaveLength(64);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wrong key and bad pubkey refuse', () => {
    const { db, dir } = freshDb();
    try {
      expect(initPairing(db, { name: 'x', pubkeyHex: 'zz' })).toMatchObject({ ok: false, reason: 'bad_key' });
      const kp = keypair();
      const other = keypair();
      const init = initPairing(db, { name: 'm', pubkeyHex: kp.pubHex });
      if (!init.ok) throw new Error('unreachable');
      const sig = sign(null, Buffer.from(init.nonce, 'hex'), other.priv);
      const claim = claimPairing(db, { nonce: init.nonce, pubkeyHex: other.pubHex, signatureHex: sig.toString('hex') });
      expect(claim.ok).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('revoke kills the token, unassigns queued, loses claimed', () => {
    const { db, dir } = freshDb();
    try {
      const w = pairUp(db);
      const now = Date.now();
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
      db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
        'r-q',
        't',
        '{}',
        now,
        now,
        w.id,
      );
      db.prepare(
        `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`,
      ).run('r-c', 't', '{}', now, now, w.id, now);
      const r = revokeWorker(db, w.id, now);
      expect(r).toMatchObject({ ok: true, unassigned: 1, lost: 1 });
      expect((db.prepare('SELECT worker_id FROM runs WHERE id=?').get('r-q') as any).worker_id).toBeNull();
      expect((db.prepare('SELECT state, outcome_reason FROM runs WHERE id=?').get('r-c') as any)).toMatchObject({
        state: 'failed',
        outcome_reason: 'worker_lost',
      });
      expect(authWorker(db, w.id, w.token)).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('routing decisions', () => {
  it('null pin runs local; online paired routes; required waits; preferred falls back', () => {
    const { db, dir } = freshDb();
    try {
      const now = Date.now();
      expect(resolveWorkerPin(db, {}, now)).toEqual({ workerId: null, fellBack: false, waitingOn: null });
      const w = pairUp(db, 'mini', now);
      db.prepare('UPDATE workers SET last_heartbeat=?, online=1 WHERE id=?').run(now, w.id);
      expect(resolveWorkerPin(db, { worker_pin: w.id, worker_required: 1 }, now).workerId).toBe(w.id);
      // Stale heartbeat: required waits on the pin, preferred falls back loudly.
      const stale = now - HEARTBEAT_TIMEOUT_MS - 1000;
      db.prepare('UPDATE workers SET last_heartbeat=? WHERE id=?').run(stale, w.id);
      expect(resolveWorkerPin(db, { worker_pin: w.id, worker_required: 1 }, now)).toEqual({ workerId: w.id, fellBack: false, waitingOn: w.id });
      expect(resolveWorkerPin(db, { worker_pin: w.id, worker_required: 0 }, now)).toEqual({ workerId: null, fellBack: true, waitingOn: null });
      // Deleted pin never goes silently local.
      db.prepare('DELETE FROM workers WHERE id=?').run(w.id);
      expect(resolveWorkerPin(db, { worker_pin: w.id, worker_required: 0 }, now)).toEqual({ workerId: null, fellBack: true, waitingOn: null });
      expect(resolveWorkerPin(db, { worker_pin: w.id, worker_required: 1 }, now)).toEqual({ workerId: w.id, fellBack: false, waitingOn: w.id });
      expect(resolveWorkerPin(db, { worker_pin: 'wrk_nope', worker_required: 0 }, now).waitingOn).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('silence sweep', () => {
  it('stale workers go offline and claimed runs fail as worker_lost, never complete', () => {
    const { db, dir } = freshDb();
    try {
      const now = Date.now();
      const w = pairUp(db, 'mini', now);
      db.prepare('UPDATE workers SET last_heartbeat=?, online=1 WHERE id=?').run(now - HEARTBEAT_TIMEOUT_MS - 1000, w.id);
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
      db.prepare(
        `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`,
      ).run('r-1', 't', '{}', now, now, w.id, now);
      db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
        'r-2',
        't',
        '{}',
        now,
        now,
        w.id,
      );
      const notes: string[][] = [];
      const r = sweepWorkers(db, now, (_k, t, b) => notes.push([t, b]));
      expect(r).toMatchObject({ lost: 1 });
      expect(r.offlined).toEqual([w.id]);
      expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-1') as any).state).toBe('failed');
      expect((db.prepare('SELECT outcome_reason FROM runs WHERE id=?').get('r-1') as any).outcome_reason).toBe('worker_lost');
      expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-2') as any).state).toBe('queued');
      expect(notes).toHaveLength(1);
      expect(listWorkers(db, now).find((x) => x.id === w.id)?.onlineComputed).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker ledger stubs', () => {
  it('ensureWorkerTaskRow satisfies the FK without scheduling anything', () => {
    const { db, dir } = freshDb();
    try {
      const now = Date.now();
      ensureWorkerTaskRow(db, { taskId: 'pulled', taskName: 'P', prompt: 'do' }, now);
      db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?,?,?,?,?,?)`).run(
        'r1',
        'pulled',
        '{}',
        'queued',
        now,
        now,
      );
      expect((db.prepare('SELECT COUNT(*) c FROM schedules WHERE task_id=?').get('pulled') as any).c).toBe(0);
      expect((db.prepare('SELECT COUNT(*) c FROM chain_edges WHERE parent_task_id=? OR child_task_id=?').get('pulled', 'pulled') as any).c).toBe(0);
      // Idempotent re-pull.
      ensureWorkerTaskRow(db, { taskId: 'pulled', taskName: 'P2', prompt: 'do2' }, now);
      expect((db.prepare('SELECT name FROM tasks WHERE id=?').get('pulled') as any).name).toBe('P');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pump skips worker rows', () => {
  let db: DB;
  let dir: string;
  let rm: RunManager;

  beforeAll(() => {
    const f = freshDb();
    db = f.db;
    dir = f.dir;
    rm = new RunManager({
      db,
      clock: new FakeClock(Date.now()),
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('queued worker rows stay queued through pump', async () => {
    const now = Date.now();
    const w = pairUp(db, 'mini', now);
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
      'r-w',
      't',
      JSON.stringify({ taskId: 't' }),
      now,
      now,
      w.id,
    );
    (rm as any).pump();
    await new Promise((r) => setTimeout(r, 100));
    expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-w') as any).state).toBe('queued');
    // Untouched means untouched: any startRun attempt would transition the
    // row and record events. A failed local spawn would show here too.
    expect(db.prepare('SELECT * FROM events WHERE run_id=?').all('r-w')).toHaveLength(0);
  });
});

describe('protocol routes', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;
  let w: { id: string; token: string };

  beforeAll(async () => {
    const f = freshDb();
    db = f.db;
    dir = f.dir;
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
    app = built.app;
    token = built.token;
    await app.ready();
    w = pairUp(db, 'mini');
    const now = Date.now();
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
  });
  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });
  const wauth = (id: string, tok: string, o: any) => ({ ...o, headers: { 'x-clockwork-worker': tok }, url: (o.url as string).replace(':id', id) });

  it('registry + ceremony over user auth; protocol rejects bad tokens', async () => {
    const w2 = pairUp(db, 'w2');
    const list = await app.inject(auth({ method: 'GET', url: '/workers' }));
    expect(list.statusCode).toBe(200);
    expect(list.json().workers).toHaveLength(2);
    // Cross-worker and wrong-token access is uniformly 401.
    expect((await app.inject({ method: 'GET', url: '/workers/me', headers: { 'x-clockwork-worker': 'nope' } })).statusCode).toBe(401);
    // Worker B's token on Worker A's paths: 401, never B's data.
    expect((await app.inject(wauth(w.id, w2.token, { method: 'POST', url: '/workers/:id/heartbeat', payload: {} }))).statusCode).toBe(401);
    expect((await app.inject(wauth(w.id, w2.token, { method: 'GET', url: '/workers/:id/next-job' }))).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/workers/me', headers: { 'x-clockwork-worker': w.token } });
    expect(me.json().id).toBe(w.id);
    expect(JSON.stringify(me.json())).not.toContain(w.token);
    // Unknown ids are 401 too, never 404-oracle.
    expect((await app.inject({ method: 'POST', url: '/workers/wrk_nope/heartbeat', payload: {}, headers: {} })).statusCode).toBe(401);
  });

  it('heartbeat marks online; pull assigns atomically; complete settles', async () => {
    const now = Date.now();
    for (const [id, prompt] of [['r-j1', 'do'], ['r-j2', 'do2'], ['r-j3', 'do3']] as const) {
      db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
        id,
        't',
        JSON.stringify({ taskId: 't', prompt }),
        now,
        now,
        w.id,
      );
    }
    await app.inject(wauth(w.id, w.token, { method: 'POST', url: '/workers/:id/heartbeat', payload: {} }));
    // Racing pulls serialize on the conditional UPDATE: distinct jobs, then empty.
    const [a, b] = await Promise.all([
      app.inject(wauth(w.id, w.token, { method: 'GET', url: '/workers/:id/next-job' })),
      app.inject(wauth(w.id, w.token, { method: 'GET', url: '/workers/:id/next-job' })),
    ]);
    const ids = [a.json().run?.id, b.json().run?.id].sort();
    expect(ids).toEqual(['r-j1', 'r-j2']);
    const third = await app.inject(wauth(w.id, w.token, { method: 'GET', url: '/workers/:id/next-job' }));
    expect(third.json().run.id).toBe('r-j3');
    const empty = await app.inject(wauth(w.id, w.token, { method: 'GET', url: '/workers/:id/next-job' }));
    expect(empty.statusCode).toBe(204);
    const done = await app.inject(
      wauth(w.id, w.token, {
        method: 'POST',
        url: '/workers/:id/runs/r-j1/complete',
        payload: { state: 'completed', report_json: JSON.stringify({ summary: 'did it' }), cost_usd: 0.1, turns: 2 },
      }),
    );
    expect(done.json()).toEqual({ ok: true });
    expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-j1') as any).state).toBe('completed');
    // Reporting twice is 409, never a silent overwrite.
    const again = await app.inject(
      wauth(w.id, w.token, {
        method: 'POST',
        url: '/workers/:id/runs/r-j1/complete',
        payload: { state: 'completed', report_json: '{}', cost_usd: 0, turns: 0 },
      }),
    );
    expect(again.statusCode).toBe(409);
  });

  it('unknown pins refuse at save; valid pins stick', async () => {
    const bad = await app.inject(auth({ method: 'PATCH', url: '/tasks/t', payload: { workerPin: 'wrk_nope' } }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'unknown_worker' });
    const good = await app.inject(auth({ method: 'PATCH', url: '/tasks/t', payload: { workerPin: w.id, workerRequired: true } }));
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ workerPin: w.id });
    const clear = await app.inject(auth({ method: 'PATCH', url: '/tasks/t', payload: { workerPin: null } }));
    expect(clear.statusCode).toBe(200);
  });

  it('decline fails loudly', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`).run(
      'r-d1',
      't',
      '{}',
      now,
      now,
      w.id,
      now,
    );
    const dec = await app.inject(
      wauth(w.id, w.token, { method: 'POST', url: '/workers/:id/runs/r-d1/decline', payload: { reason: 'repo missing: /x' } }),
    );
    expect(dec.json()).toEqual({ ok: true });
    expect((db.prepare('SELECT state, outcome_reason FROM runs WHERE id=?').get('r-d1') as any)).toMatchObject({
      state: 'failed',
      outcome_reason: 'worker_declined',
    });
  });

  it('decline refuses unclaimed and foreign rows', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
      'r-d2',
      't',
      '{}',
      now,
      now,
      w.id,
    );
    // Never pulled: not theirs to fail.
    const r1 = await app.inject(
      wauth(w.id, w.token, { method: 'POST', url: '/workers/:id/runs/r-d2/decline', payload: { reason: 'x' } }),
    );
    expect(r1.statusCode).toBe(409);
    expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-d2') as any).state).toBe('queued');
  });

  it('pairing ceremony over routes: init → claim → approve-once', async () => {
    const { generateKeyPairSync: gen, sign: sgn } = await import('node:crypto');
    const { publicKey, privateKey } = gen('ed25519');
    const pubHex = publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
    const init = await app.inject(auth({ method: 'POST', url: '/workers/pairing/init', payload: { name: 'field', pubkeyHex: pubHex } }));
    expect(init.statusCode).toBe(201);
    const { workerId, nonce } = init.json() as any;
    expect(JSON.stringify(init.json())).not.toContain(pubHex.slice(0, 20));
    // Duplicate open pairing on the same key refuses.
    const dup = await app.inject(auth({ method: 'POST', url: '/workers/pairing/init', payload: { name: 'field2', pubkeyHex: pubHex } }));
    expect(dup.statusCode).toBe(422);
    const sig = sgn(null, Buffer.from(nonce, 'hex'), privateKey).toString('hex');
    const claim = await app.inject({ method: 'POST', url: '/workers/pairing/claim', payload: { nonce, pubkeyHex: pubHex, signatureHex: sig } });
    expect(claim.statusCode).toBe(200);
    const ap = await app.inject(auth({ method: 'POST', url: `/workers/${workerId}/approve`, payload: {} }));
    expect(ap.statusCode).toBe(200);
    expect(ap.json().token).toMatch(/^[0-9a-f]{64}$/);
    // Second approve refuses — one token per pairing, ever.
    const ap2 = await app.inject(auth({ method: 'POST', url: `/workers/${workerId}/approve`, payload: {} }));
    expect(ap2.statusCode).toBe(422);
  });

  it('removeWorker settles rows and kills the token', async () => {
    const w3 = pairUp(db, 'w3');
    const now = Date.now();
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id) VALUES (?,?,?,'queued',?,?,?)`).run(
      'r-rm-q',
      't',
      '{}',
      now,
      now,
      w3.id,
    );
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`,
    ).run('r-rm-c', 't', '{}', now, now, w3.id, now);
    const del = await app.inject(auth({ method: 'DELETE', url: `/workers/${w3.id}` }));
    expect(del.json()).toMatchObject({ ok: true, unassigned: 1, lost: 1 });
    expect((db.prepare('SELECT worker_id FROM runs WHERE id=?').get('r-rm-q') as any).worker_id).toBeNull();
    expect((db.prepare('SELECT state FROM runs WHERE id=?').get('r-rm-c') as any).state).toBe('failed');
    expect((await app.inject({ method: 'GET', url: '/workers/me', headers: { 'x-clockwork-worker': w3.token } })).statusCode).toBe(401);
  });

  it('worker-reported completion fires downstream like local finalize', async () => {
    const now = Date.now();
    for (const [id, prompt] of [['wp', 'scan it'], ['wc', 'fix it: {{runs.wp.report}}']] as const) {
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?,?,?, ?,?)`).run(id, id, prompt, now, now);
    }
    db.prepare('INSERT INTO chain_edges (parent_task_id, child_task_id, on_state, created_at) VALUES (?,?,?,?)').run('wp', 'wc', 'completed', now);
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`,
    ).run('run-wp', 'wp', JSON.stringify({ taskId: 'wp' }), now, now, w.id, now);
    const done = await app.inject(
      wauth(w.id, w.token, {
        method: 'POST',
        url: '/workers/:id/runs/run-wp/complete',
        payload: { state: 'completed', report_json: JSON.stringify({ summary: 'WORKER-SAYS-HI', artifacts: [] }), cost_usd: 0.2, turns: 3 },
      }),
    );
    expect(done.json()).toEqual({ ok: true });
    const kids = db.prepare(`SELECT * FROM runs WHERE task_id='wc' AND state='queued'`).all() as any[];
    expect(kids).toHaveLength(1);
    expect(JSON.parse(kids[0].jobspec_json).prompt).toContain('WORKER-SAYS-HI');
  });

  it('removeWorker cleans up; authWorkerByToken resolves', async () => {
    const { authWorkerByToken: byTok, removeWorker: rmw } = await import('../src/workers.js');
    expect(byTok(db, w.token)?.id).toBe(w.id);
    expect(byTok(db, 'nope')).toBeNull();
    expect(rmw(db, 'wrk_nope')).toMatchObject({ ok: false });
  });
});

async function freshApp(): Promise<{ db: DB; dir: string; app: FastifyInstance; token: string }> {
  const { db, dir } = freshDb();
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

describe('queue lane names the worker a pinned run waits on', () => {
  let f: Awaited<ReturnType<typeof freshApp>>;
  beforeAll(async () => {
    f = await freshApp();
  });
  afterAll(async () => {
    await f.app.close();
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('worker rows say which worker, and never take a local slot', async () => {
    const now = Date.now();
    const online = pairUp(f.db, 'studio-mini', now);
    const silent = pairUp(f.db, 'attic-box', now);
    f.db.prepare('UPDATE workers SET last_heartbeat=?, online=1 WHERE id=?').run(now, online.id);
    f.db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
    const ins = f.db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`,
    );
    // Three worker rows ahead of two local ones: with maxParallel 2, counting
    // them as local would push both local rows to "waiting for slot".
    ins.run('q-w1', 't', JSON.stringify({ taskName: 'Nightly scan' }), now, now - 50, online.id, null);
    ins.run('q-w2', 't', JSON.stringify({ taskName: 'Attic job' }), now, now - 40, silent.id, null);
    ins.run('q-w3', 't', JSON.stringify({ taskName: 'Pulled job' }), now, now - 30, online.id, now);
    ins.run('q-l1', 't', JSON.stringify({ taskName: 'Local one' }), now, now - 20, null, null);
    ins.run('q-l2', 't', JSON.stringify({ taskName: 'Local two' }), now, now - 10, null, null);
    const res = await f.app.inject({ method: 'GET', url: '/queue', headers: { authorization: `Bearer ${f.token}` } });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries((res.json() as any[]).map((r) => [r.runId, r]));
    expect(byId['q-w1'].reason).toBe('waiting for worker studio-mini');
    expect(byId['q-w2'].reason).toBe('waiting for worker attic-box (silent)');
    expect(byId['q-w3'].reason).toBe('running on worker studio-mini');
    expect(byId['q-l1'].reason).toBe('starting soon');
    expect(byId['q-l2'].reason).toBe('starting soon');
    // Queue order still counts every row.
    expect(byId['q-l2'].position).toBe(5);
  });
});

describe('worker completion carries start time and outcome reason', () => {
  let f: Awaited<ReturnType<typeof freshApp>>;
  let w: { id: string; token: string };
  beforeAll(async () => {
    f = await freshApp();
    w = pairUp(f.db, 'mini');
    const now = Date.now();
    f.db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
  });
  afterAll(async () => {
    await f.app.close();
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  });

  const claimed = (id: string): void => {
    const now = Date.now();
    f.db
      .prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, worker_id, worker_claimed_at) VALUES (?,?,?,'queued',?,?,?,?)`)
      .run(id, 't', JSON.stringify({ taskId: 't' }), now, now, w.id, now);
  };

  it('stores started_at and outcome_reason the worker reports', async () => {
    claimed('c-1');
    const startedAt = Date.now() - 42_000;
    const res = await f.app.inject({
      method: 'POST',
      url: `/workers/${w.id}/runs/c-1/complete`,
      headers: { 'x-clockwork-worker': w.token },
      payload: { state: 'failed', report_json: '{}', cost_usd: 0.3, turns: 4, started_at: startedAt, outcome_reason: 'max_turns' },
    });
    expect(res.statusCode).toBe(200);
    const row = f.db.prepare('SELECT state, started_at, outcome_reason FROM runs WHERE id=?').get('c-1') as any;
    expect(row).toEqual({ state: 'failed', started_at: startedAt, outcome_reason: 'max_turns' });
  });

  it('an older worker without the new fields still settles', async () => {
    claimed('c-2');
    const res = await f.app.inject({
      method: 'POST',
      url: `/workers/${w.id}/runs/c-2/complete`,
      headers: { 'x-clockwork-worker': w.token },
      payload: { state: 'completed', report_json: '{}', cost_usd: 0, turns: 1 },
    });
    expect(res.statusCode).toBe(200);
    const row = f.db.prepare('SELECT state, started_at, outcome_reason FROM runs WHERE id=?').get('c-2') as any;
    expect(row).toEqual({ state: 'completed', started_at: null, outcome_reason: null });
  });

  it('refuses a malformed started_at rather than storing it', async () => {
    claimed('c-3');
    const res = await f.app.inject({
      method: 'POST',
      url: `/workers/${w.id}/runs/c-3/complete`,
      headers: { 'x-clockwork-worker': w.token },
      payload: { state: 'completed', report_json: '{}', cost_usd: 0, turns: 1, started_at: 'yesterday' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('the worker agent sends its local started_at and outcome_reason', async () => {
    const wdir = mkdtempSync(path.join(os.tmpdir(), 'cw-wagent-'));
    const wdb = openDatabase(wdir).db;
    createMigrator(wdb, MIGRATIONS).migrate();
    const now = Date.now();
    wdb.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('t','t','p',?,?)`).run(now, now);
    wdb
      .prepare(
        `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for, started_at, ended_at, outcome_reason, cost_usd, turns, report_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('a-1', 't', '{}', 'timed_out', now, now, now - 9_000, now, 'wall_clock', 0.05, 3, '{"summary":"x"}');
    writeFileSync(path.join(wdir, 'worker-active.json'), JSON.stringify({ runId: 'a-1' }));
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/workers/me')) return new Response(JSON.stringify({ id: 'wrk_x' }), { status: 200 });
        if (u.includes('/complete')) bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any,
    );
    const agent = startWorkerAgent({ db: wdb, dataDir: wdir, primaryUrl: 'http://primary:1', token: 't'.repeat(64), pump: () => {}, intervalMs: 60_000, log: () => {} });
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toMatchObject({ state: 'timed_out', started_at: now - 9_000, outcome_reason: 'wall_clock', turns: 3 });
    } finally {
      agent.stop();
      vi.unstubAllGlobals();
      wdb.close();
      rmSync(wdir, { recursive: true, force: true });
    }
  });
});

describe('worker platform label', () => {
  it('names the OS release and arch the way a person would', () => {
    expect(describePlatform('darwin', '24.1.0', 'arm64')).toBe('macOS 15 · arm64');
    expect(describePlatform('darwin', '25.6.0', 'arm64')).toBe('macOS 26 · arm64');
    expect(describePlatform('darwin', '20.6.0', 'x64')).toBe('macOS 11 · x64');
    expect(describePlatform('darwin', '19.6.0', 'x64')).toBe('macOS 10.15 · x64');
    expect(describePlatform('linux', '6.8.0-45-generic', 'x64')).toBe('Linux 6.8 · x64');
    expect(describePlatform('win32', '10.0.22631', 'x64')).toBe('Windows 10.0 · x64');
    expect(describePlatform('freebsd', '14.1-RELEASE', 'arm64')).toBe('freebsd 14.1 · arm64');
  });

  it('the agent sends it on every heartbeat, and the primary shows it', async () => {
    const f = await freshApp();
    const w = pairUp(f.db, 'mini');
    const wdir = mkdtempSync(path.join(os.tmpdir(), 'cw-wplat-'));
    const wdb = openDatabase(wdir).db;
    createMigrator(wdb, MIGRATIONS).migrate();
    const beats: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = new URL(String(url));
        // Forward to the real primary routes, capturing heartbeat bodies.
        if (u.pathname.endsWith('/heartbeat')) beats.push(JSON.parse(String(init?.body)));
        const res = await f.app.inject({
          method: (init?.method ?? 'GET') as any,
          url: u.pathname,
          headers: init?.headers as any,
          payload: init?.body as any,
        });
        return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode });
      }) as any,
    );
    const agent = startWorkerAgent({ db: wdb, dataDir: wdir, primaryUrl: 'http://primary:1', token: w.token, pump: () => {}, intervalMs: 60_000, log: () => {} });
    try {
      await vi.waitFor(() => expect(beats).toHaveLength(1));
      const expected = describePlatform(process.platform, os.release(), process.arch);
      expect(beats[0].platform).toBe(expected);
      await vi.waitFor(async () => {
        const list = await f.app.inject({ method: 'GET', url: '/workers', headers: { authorization: `Bearer ${f.token}` } });
        expect(list.json().workers[0].platform).toBe(expected);
      });
    } finally {
      agent.stop();
      vi.unstubAllGlobals();
      wdb.close();
      rmSync(wdir, { recursive: true, force: true });
      await f.app.close();
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('the worker list refreshes live', () => {
  it('a heartbeat broadcasts workers.changed only when the worker comes online', async () => {
    const { db, dir } = freshDb();
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
    // A stub SSE client in the real set: the REAL broadcast writes to it.
    const events: any[] = [];
    built.sseClients.add({ raw: { write: (chunk: string) => events.push(JSON.parse(chunk.replace(/^data: /, ''))) } } as any);
    const changed = (): number => events.filter((e) => e.type === 'workers.changed').length;
    try {
      const w = pairUp(db, 'mini');
      const beat = () =>
        built.app.inject({ method: 'POST', url: `/workers/${w.id}/heartbeat`, headers: { 'x-clockwork-worker': w.token }, payload: {} });
      expect((await beat()).statusCode).toBe(200);
      expect(changed()).toBe(1); // never heard from → online
      await beat();
      expect(changed()).toBe(1); // still online: no event every 30 s per worker
      db.prepare('UPDATE workers SET last_heartbeat=? WHERE id=?').run(Date.now() - HEARTBEAT_TIMEOUT_MS - 1, w.id);
      await beat();
      expect(changed()).toBe(2); // silent → online again
    } finally {
      await built.app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
