/**
 * Template packs (P6): canonical signing, TOFU trust, version gates, whole-
 * pack red refusal, disabled arrival, honest uninstall — plus the routes.
 *
 * Keys are generated in-test (ed25519); signatures prove against real
 * crypto, never fixtures. Tamper, rotation, downgrade and red-template paths
 * all refuse with the reason named.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  stableStringify,
  keyIdOf,
  signPack,
  verifyPack,
  fetchPack,
  loadTrustedKeys,
  pinTrustedKey,
  cmpPackVersions,
  type PackFile,
} from '../src/packs.js';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-pack-'));
  const db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  return { db, dir };
}

function keypair(): { pubHex: string; privHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubHex: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privHex: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
  };
}

const TPL = (name: string, extra: Record<string, unknown> = {}): any => ({
  schema: 'clockwork.template.v1',
  name,
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
  schedule: { kind: 'queue', tz: 'UTC' },
  missedPolicy: 'run-late',
  overlapPolicy: 'skip',
  delivery: { osNotify: true },
  ...extra,
});

function makePack(privHex: string, over: Record<string, unknown> = {}): PackFile {
  const manifest = { name: 'nightly-triage', version: '1.0.0', publisher: 'team', ...(over.manifest as any) };
  const templates = (over.templates as any[]) ?? [TPL('triage')];
  const sig = signPack(privHex, manifest, templates);
  return { schema: 'clockwork.pack.v1', manifest, templates, signatures: [sig] };
}

describe('canonical form + signing', () => {
  it('stableStringify is order-independent and byte-stable', () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(stableStringify([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });

  it('sign/verify round-trips; tampering fails', () => {
    const kp = keypair();
    const pack = makePack(kp.privHex);
    const trusted = new Map([[pack.signatures[0]!.keyId, { pubkeyHex: kp.pubHex, publisher: 'team', trustedAt: 1 }]]);
    expect(verifyPack(pack, trusted, '0.13.0')).toEqual({ ok: true, keyId: pack.signatures[0]!.keyId });
    const evil = { ...pack, manifest: { ...pack.manifest, version: '9.9.9' } };
    expect(verifyPack(evil, trusted, '0.13.0')).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('unknown keys name the fingerprint; rotation refuses as key_changed', () => {
    const kp = keypair();
    const pack = makePack(kp.privHex);
    const r = verifyPack(pack, new Map(), '0.13.0');
    expect(r).toMatchObject({ ok: false, reason: 'unknown_key' });
    if (!r.ok && r.reason === 'unknown_key') expect(r.keyId).toBe(pack.signatures[0]!.keyId);
    const other = keypair();
    const trusted = new Map([[pack.signatures[0]!.keyId, { pubkeyHex: other.pubHex, publisher: 'x', trustedAt: 1 }]]);
    // Same keyId, different bytes cannot happen (keyId hashes the bytes) —
    // simulate a pinned-then-changed key directly.
    expect(verifyPack(pack, trusted, '0.13.0')).toMatchObject({ ok: false, reason: 'key_changed' });
  });

  it('version gates: bad x.y.z, incompatible minimum, empty pack', () => {
    const kp = keypair();
    const trusted = new Map<string, string>();
    const bad = makePack(kp.privHex, { manifest: { name: 'n', version: '1.0', publisher: 'p' } });
    expect(verifyPack(bad, trusted, '0.13.0')).toMatchObject({ ok: false, reason: 'bad_shape' });
    const future = makePack(kp.privHex, { manifest: { name: 'n', version: '1.0.0', publisher: 'p', minClockworkVersion: '99.0.0' } });
    expect(verifyPack(future, trusted, '0.13.0')).toMatchObject({ ok: false, reason: 'incompatible' });
    const empty = makePack(kp.privHex, { templates: [] });
    expect(verifyPack(empty, trusted, '0.13.0')).toMatchObject({ ok: false, reason: 'bad_shape' });
    expect(cmpPackVersions('1.2.3', '1.2.3')).toBe(0);
    expect(cmpPackVersions('1.2.4', '1.2.3')).toBe(1);
    expect(cmpPackVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(cmpPackVersions('x', '1.2.3')).toBeNull();
  });
});

describe('trust store + fetch guards', () => {
  it('pins 0600 and reloads', () => {
    const { db, dir } = freshDb();
    try {
      const kp = keypair();
      const id = keyIdOf(kp.pubHex);
      pinTrustedKey(dir, id, kp.pubHex, 'team');
      const st = statSync(`${dir}/trusted-pack-keys.json`);
      expect(st.mode & 0o777).toBe(0o600);
      expect(loadTrustedKeys(dir).get(id)?.publisher).toBe('team');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetch refuses non-https and caps size', async () => {
    expect((await fetchPack('http://x/y')).reason).toBe('bad_url');
    expect((await fetchPack('file:///x')).reason).toBe('bad_url');
    const bigText = 'x'.repeat(3 * 1024 * 1024);
    const big: any = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          // Two chunks: the cap must trip mid-stream, not after buffering.
          c.enqueue(new TextEncoder().encode(bigText.slice(0, 2 * 1024 * 1024)));
          c.enqueue(new TextEncoder().encode(bigText.slice(2 * 1024 * 1024)));
          c.close();
        },
      }),
    });
    expect((await fetchPack('https://x/y', big as any)).reason).toBe('too_large');
    const nf: any = async () => ({ ok: false, status: 404, body: null, text: async () => '' });
    expect((await fetchPack('https://x/y', nf as any)).reason).toBe('network');
  });
});

describe('install flow over routes', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;
  const kp = keypair();

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
    const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: '0.13.0' });
    app = built.app;
    token = built.token;
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });

  it('preview shows manifest, trust state and per-template flags without installing', async () => {
    const pack = makePack(kp.privHex);
    const r = await app.inject(auth({ method: 'POST', url: '/packs/preview', payload: { pack } }));
    expect(r.statusCode).toBe(200);
    const b = r.json() as any;
    expect(b.manifest.name).toBe('nightly-triage');
    expect(b.verified).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(b.verified.keyId).toBe(pack.signatures[0]!.keyId);
    expect(b.templates).toHaveLength(1);
    expect(b.blocked).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(0);
  });

  it('install without trust refuses; with trustKey installs disabled tasks', async () => {
    const pack = makePack(kp.privHex);
    const noTrust = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack } }));
    expect(noTrust.statusCode).toBe(422);
    expect(noTrust.json()).toMatchObject({ error: 'unknown_key' });
    const yes = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack, trustKey: true } }));
    expect(yes.statusCode).toBe(201);
    expect(yes.json().tasks).toHaveLength(1);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(yes.json().tasks[0].taskId) as any;
    expect(Number(task.enabled)).toBe(0);
    expect(task.budget_usd).toBe(2);
    // Second install of the same version refuses; force reinstalls.
    const again = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack, trustKey: true } }));
    expect(again.statusCode).toBe(409);
    const forced = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack, trustKey: true, force: true } }));
    expect(forced.statusCode).toBe(201);
  });

  it('one red template refuses the whole pack; nothing is created', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c;
    const pack = makePack(kp.privHex, { manifest: { name: 'evil-pack', version: '1.0.0', publisher: 'x' }, templates: [TPL('ok'), TPL('evil', { permissionMode: 'bypassPermissions' })] });
    const r = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack, trustKey: true } }));
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'template_rejected' });
    expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(before);
  });

  it('downgrades refuse; uninstall removes only untouched tasks', async () => {
    const v2 = makePack(kp.privHex, { manifest: { name: 'nightly-triage', version: '2.0.0', publisher: 'team' } });
    const up = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack: v2, trustKey: true } }));
    expect(up.statusCode).toBe(201);
    const v1 = makePack(kp.privHex, { manifest: { name: 'nightly-triage', version: '1.0.0', publisher: 'team' } });
    const down = await app.inject(auth({ method: 'POST', url: '/packs/install', payload: { pack: v1, trustKey: true } }));
    expect(down.statusCode).toBe(409);
    // Enable one task and run another: uninstall keeps both, removes the rest.
    const listed = await app.inject(auth({ method: 'GET', url: '/packs/installed' }));
    expect(listed.json().packs.find((p: any) => p.name === 'nightly-triage')?.version).toBe('2.0.0');
    const ids = db.prepare('SELECT task_id FROM installed_pack_tasks WHERE pack_name=?').all('nightly-triage') as any[];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    db.prepare('UPDATE tasks SET enabled=1 WHERE id=?').run(ids[0]!.task_id);
    const now = Date.now();
    db.prepare(`INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?,?,?,?,?,?)`).run(
      'run_keep', ids[1]!.task_id, '{}', 'completed', now, now,
    );
    const del = await app.inject(auth({ method: 'DELETE', url: '/packs/nightly-triage' }));
    expect(del.json().kept).toHaveLength(2);
    // Untouched pack tasks are soft-deleted; the enabled and the run one live on.
    const alive = (db.prepare('SELECT id FROM tasks WHERE deleted_at IS NULL').all() as any[]).map((r) => r.id);
    expect(alive).toContain(ids[0]!.task_id);
    expect(alive).toContain(ids[1]!.task_id);
    const gone = (db.prepare('SELECT task_id FROM installed_pack_tasks WHERE pack_name=?').all('nightly-triage') as any[]);
    expect(gone).toHaveLength(0); // mapping cascades with the pack row
  });
});
