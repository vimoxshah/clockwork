/**
 * GET /tasks/:id/schedule (P2): the mover's read path. TaskViewT carries
 * only nextFire, so drag/drop needs kind + rule + zone + version CAS in one
 * authenticated read — and nothing beyond what GET /tasks already returns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

describe('GET /tasks/:id/schedule', () => {
  let db: DB;
  let dir: string;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cw-task-sched-'));
    const opened = openDatabase(dir);
    db = opened.db;
    createMigrator(db, MIGRATIONS).migrate();
    const clock = new FakeClock(Date.now());
    const rm = new RunManager({
      db,
      clock,
      dataDir: dir,
      runnerChildModule: '/nonexistent/runner-child.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
    });
    const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
    const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
    app = built.app;
    token = built.token;
    await app.ready();
    const now = Date.now();
    db.prepare('INSERT INTO tasks (id, name, prompt, version, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
      't1',
      't',
      'p',
      4,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO schedules (id, task_id, kind, rrule, tz, next_fire, enabled) VALUES (?,?,?,?,?,?,?)",
    ).run('s1', 't1', 'rrule', 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0', 'America/New_York', now + 3600_000, 1);
  });
  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const auth = (o: any) => ({ ...o, headers: { authorization: `Bearer ${token}` } });

  it('rejects unauthenticated reads', async () => {
    expect((await app.inject({ method: 'GET', url: '/tasks/t1/schedule' })).statusCode).toBe(401);
  });

  it('returns kind + rule + zone + version, nothing else task-shaped', async () => {
    const r = await app.inject(auth({ method: 'GET', url: '/tasks/t1/schedule' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      kind: 'rrule',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0',
      cron: null,
      runAt: null,
      tz: 'America/New_York',
      version: 4,
    });
  });

  it('404s unknown tasks', async () => {
    expect((await app.inject(auth({ method: 'GET', url: '/tasks/nope/schedule' }))).statusCode).toBe(404);
  });
});
