/**
 * Mini-side join (Settings › Workers) + GitHub webhook secret from the app.
 *
 * Trust properties asserted here, not described:
 * - /worker/* takes user auth (401 anonymous), like every other control route
 * - join stores { primaryUrl, token } 0600 and NEVER returns the token —
 *   status reports the primary host and which source won, nothing else
 * - env wins over the file; a malformed worker.json resolves to unjoined,
 *   never to a half-credential poll loop
 * - keygen returns the public half only; the private key is 0600 on disk
 * - the GitHub verification secret resolves env-first, file-second, and
 *   null when neither exists (hook firing must fail closed on null)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import {
  readWorkerJoin,
  writeWorkerJoin,
  clearWorkerJoin,
  resolveWorkerCreds,
  workerJoinPath,
} from '../src/worker-agent.js';
import { resolveGithubWebhookSecret } from '../src/delivery.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

describe('worker join routes + join-file custody', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;
  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-join-'));
    db = openDatabase(dir).db;
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

  it('status starts unjoined and requires user auth', async () => {
    const anon = await app.inject({ method: 'GET', url: '/worker/status' });
    expect(anon.statusCode).toBe(401);
    const res = await app.inject(auth({ method: 'GET', url: '/worker/status' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ joined: false, primaryHost: null, via: null });
  });

  it('join rejects non-http URLs and short tokens', async () => {
    expect(
      (await app.inject(auth({ method: 'POST', url: '/worker/join', payload: { primaryUrl: 'ftp://x/y', token: 'a'.repeat(64) } }))).statusCode,
    ).toBe(422);
    expect(
      (await app.inject(auth({ method: 'POST', url: '/worker/join', payload: { primaryUrl: 'http://mini:8787', token: 'short' } }))).statusCode,
    ).toBe(422);
    expect(existsSync(workerJoinPath(dir))).toBe(false);
  });

  it('join persists 0600, returns host but never the token', async () => {
    const tok = 'b'.repeat(64);
    const res = await app.inject(
      auth({ method: 'POST', url: '/worker/join', payload: { primaryUrl: 'http://mini:8787', token: tok } }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.primaryHost).toBe('mini:8787');
    expect(JSON.stringify(body)).not.toContain(tok);
    // 0600 on disk, exact roundtrip.
    expect(statSync(workerJoinPath(dir)).mode & 0o777).toBe(0o600);
    expect(readWorkerJoin(dir)).toEqual({ primaryUrl: 'http://mini:8787', token: tok });
    const st = await app.inject(auth({ method: 'GET', url: '/worker/status' }));
    const sbody = st.json();
    expect(sbody).toEqual({ joined: true, primaryHost: 'mini:8787', via: 'file' });
    expect(JSON.stringify(sbody)).not.toContain(tok);
  });

  it('env wins over the file; malformed file resolves to unjoined', async () => {
    vi.stubEnv('CLOCKWORK_WORKER_PRIMARY', 'https://primary-tail:8787');
    vi.stubEnv('CLOCKWORK_WORKER_TOKEN', 'c'.repeat(64));
    expect(resolveWorkerCreds(dir)).toEqual({ primaryUrl: 'https://primary-tail:8787', token: 'c'.repeat(64) });
    const st = await app.inject(auth({ method: 'GET', url: '/worker/status' }));
    expect(st.json()).toEqual({ joined: true, primaryHost: 'primary-tail:8787', via: 'env' });
    vi.unstubAllEnvs();
    // file still governs once env is gone…
    expect(resolveWorkerCreds(dir)?.primaryUrl).toBe('http://mini:8787');
    // …and garbage on disk is unjoined, not a half credential.
    writeFileSync(workerJoinPath(dir), '{not json', 'utf8');
    expect(readWorkerJoin(dir)).toBeNull();
    expect(resolveWorkerCreds(dir)).toBeNull();
  });

  it('leave clears the file and status returns to unjoined', async () => {
    writeWorkerJoin(dir, { primaryUrl: 'http://mini:8787', token: 'b'.repeat(64) });
    const res = await app.inject(auth({ method: 'POST', url: '/worker/leave', payload: {} }));
    expect(res.statusCode).toBe(200);
    expect(existsSync(workerJoinPath(dir))).toBe(false);
    expect((await app.inject(auth({ method: 'GET', url: '/worker/status' })).then((r) => r.json())).joined).toBe(false);
    // leave is idempotent — no file, no error.
    expect((await app.inject(auth({ method: 'POST', url: '/worker/leave', payload: {} }))).statusCode).toBe(200);
  });

  it('keygen returns the public half only; private key is 0600 on disk', async () => {
    const res = await app.inject(auth({ method: 'POST', url: '/worker/keygen', payload: {} }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicKeyHex).toMatch(/^[0-9a-f]{64,}$/);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('private');
    const keyPath = path.join(dir, 'worker-key');
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath, 'utf8')).toMatch(/^[0-9a-f]{64,}$/);
  });

  it('clearWorkerJoin on a missing file does not throw', async () => {
    clearWorkerJoin(dir);
    expect(readWorkerJoin(dir)).toBeNull();
  });
});

describe('github webhook secret resolution', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ghsec-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('null with neither env nor file; file fills in; env wins', async () => {
    vi.stubEnv('CLOCKWORK_GITHUB_WEBHOOK_SECRET', '');
    expect(resolveGithubWebhookSecret(dir)).toBeNull();
    const { writeDeliveryCreds } = await import('../src/delivery.js');
    writeDeliveryCreds(dir, { githubWebhookSecret: 'file-secret-123' });
    expect(resolveGithubWebhookSecret(dir)).toBe('file-secret-123');
    vi.stubEnv('CLOCKWORK_GITHUB_WEBHOOK_SECRET', 'env-secret-456');
    expect(resolveGithubWebhookSecret(dir)).toBe('env-secret-456');
    vi.unstubAllEnvs();
  });

  it('delivery-config PUT validates length and round-trips configured state', async () => {
    const fdb = openDatabase(dir).db;
    createMigrator(fdb, MIGRATIONS).migrate();
    const rm = new RunManager({
      db: fdb,
      clock: new FakeClock(Date.now()),
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
    const scheduler = new Scheduler({ db: fdb, clock: new FakeClock(Date.now()), enqueueRun: () => {}, notify: () => {} });
    const built = await buildServer({ db: fdb, dataDir: dir, runManager: rm, scheduler, version: 'test' });
    const a2 = built.app;
    await a2.ready();
    const a2auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${built.token}` } });
    try {
      // short secret rejected, nothing persisted
      expect(
        (await a2.inject(a2auth({ method: 'PUT', url: '/delivery-config', payload: { githubWebhookSecret: 'short' } }))).statusCode,
      ).toBe(422);
      const put = await a2.inject(a2auth({ method: 'PUT', url: '/delivery-config', payload: { githubWebhookSecret: 'rotated-secret-789' } }));
      expect(put.statusCode).toBe(200);
      expect(put.json().githubWebhook).toEqual({ configured: true });
      const get = await a2.inject(a2auth({ method: 'GET', url: '/delivery-config' }));
      expect(get.json().githubWebhook).toEqual({ configured: true });
      // null clears
      const clr = await a2.inject(a2auth({ method: 'PUT', url: '/delivery-config', payload: { githubWebhookSecret: null } }));
      expect(clr.json().githubWebhook).toEqual({ configured: false });
    } finally {
      await a2.close();
      fdb.close();
    }
  });
});
