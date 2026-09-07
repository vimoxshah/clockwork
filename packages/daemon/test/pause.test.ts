/**
 * Pause has to actually stop work.
 *
 * The bug: `paused` was a plain local declared inside `buildServer`. /health,
 * /widget/snapshot and /support/bundle reported it and nothing else read it.
 * The run manager never saw it, so a paused daemon dequeued, started and
 * completed runs while telling the user it had stopped.
 *
 * The contract under test is the product's own wording
 * (packages/ui/src/components/SettingsView.tsx, "Pause all scheduling"):
 *
 *     "Queued and future runs hold until resumed. Active runs finish."
 *
 * So: a paused daemon starts NOTHING new; a run already in flight is left
 * alone; resuming releases what was held. And because a pause that forgets
 * itself on restart is the same lie in slower motion, the flag is durable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, enqueueRunNow } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let dir: string;
let db: DB;
let clock: FakeClock;
let rm: RunManager;
let scheduler: Scheduler;
let app: FastifyInstance;
let token: string;
let schedulerFires: number;
let realHome: string | undefined;

const VALID_TASK = {
  name: 'Pause probe',
  prompt: 'Summarize open TODOs in this repo.',
  schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
};

const auth = (json: Record<string, unknown>): any => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

/** pump() defers through setImmediate; two turns is past startRun's first transition. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const stateOf = (runId: string): string =>
  (db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state;

const taskRow = (taskId: string): any => db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

/** A second daemon process over the SAME data dir + db — i.e. a restart. */
const restartDaemon = async (): Promise<{ manager: RunManager; server: FastifyInstance; bearer: string }> => {
  const manager = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const sched = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: manager, scheduler: sched, version: 'test' });
  await built.app.ready();
  return { manager, server: built.app, bearer: built.token };
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-pause-'));
  // Scratch/worktree paths are built from HOME. Point it at the temp dir so a
  // run that DOES start (the resume case, and the pre-fix red run) leaves its
  // debris where afterEach deletes it.
  realHome = process.env.HOME;
  process.env.HOME = dir;

  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(Date.now());
  schedulerFires = 0;

  rm = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // never reached while paused
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  scheduler = new Scheduler({ db, clock, enqueueRun: () => { schedulerFires++; }, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterEach(async () => {
  scheduler.stop();
  await app.close();
  db.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const createTask = async (): Promise<string> => {
  const res = await app.inject(auth({ method: 'POST', url: '/tasks', payload: VALID_TASK }));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

describe('paused daemon does not start work', () => {
  // pump() is the ONLY caller of startRun (run-manager.ts), and every booking
  // path — scheduler tick, run-now, webhook fire, chain firing, sentinel
  // booking, self-healing, plan-execute — inserts a 'queued' row and then
  // calls pump(). So this one assertion is the chokepoint for all of them.
  it('holds a queued run at the pump chokepoint every booking path funnels through', async () => {
    const taskId = await createTask();
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));

    const runId = enqueueRunNow(db, taskRow(taskId));
    rm.pump();
    await settle();

    expect(stateOf(runId)).toBe('queued');
  });

  it('books a run-now but does not start it', async () => {
    const taskId = await createTask();
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));

    const res = await app.inject(auth({ method: 'POST', url: `/tasks/${taskId}/run-now` }));
    expect(res.statusCode).toBe(202);
    const runId = res.json().runId as string;
    await settle();

    // "Queued and future runs hold until resumed": the row exists and waits.
    expect(stateOf(runId)).toBe('queued');
  });

  it('tells the queue lane the honest reason', async () => {
    const taskId = await createTask();
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    await app.inject(auth({ method: 'POST', url: `/tasks/${taskId}/run-now` }));
    await settle();

    const q = await app.inject(auth({ method: 'GET', url: '/queue' }));
    expect(q.json()[0].reason).toBe('paused');
  });

  it('does not let the scheduler tick fire a due occurrence', async () => {
    const taskId = await createTask();
    db.prepare('UPDATE schedules SET next_fire=? WHERE task_id=?').run(Date.now() - 1000, taskId);
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));

    // main.ts calls scheduler.start(30_000) unconditionally at boot; a paused
    // daemon must not start ticking just because the process came back up.
    scheduler.start(30_000);
    await settle();

    expect(schedulerFires).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM runs WHERE task_id=?').get(taskId) as { c: number }).c,
    ).toBe(0);
  });
});

describe('resume', () => {
  it('releases a run that was held while paused', async () => {
    const taskId = await createTask();
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    const runId = (await app.inject(auth({ method: 'POST', url: `/tasks/${taskId}/run-now` }))).json()
      .runId as string;
    await settle();
    expect(stateOf(runId)).toBe('queued');

    const res = await app.inject(auth({ method: 'POST', url: '/resume' }));
    expect(res.json().paused).toBe(false);
    await settle();

    // Resuming must actually pump; flipping the flag alone would leave the run
    // stuck until some unrelated finalize happened to kick the queue.
    expect(stateOf(runId)).not.toBe('queued');
  });

  it('lets the scheduler tick again', async () => {
    const taskId = await createTask();
    db.prepare('UPDATE schedules SET next_fire=? WHERE task_id=?').run(Date.now() - 1000, taskId);
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    scheduler.start(30_000);
    await settle();
    expect(schedulerFires).toBe(0);

    await app.inject(auth({ method: 'POST', url: '/resume' }));
    await settle();

    expect(schedulerFires).toBe(1);
  });
});

describe('pause survives a daemon restart', () => {
  it('comes back paused and still refuses to start held work', async () => {
    const taskId = await createTask();
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    const runId = enqueueRunNow(db, taskRow(taskId));

    const next = await restartDaemon();
    try {
      expect(next.manager.isPaused()).toBe(true);

      const health = await next.server.inject({
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${next.bearer}` },
      });
      expect(health.json().paused).toBe(true);

      // The startup recovery sweep re-pumps every queued row (main.ts). It must
      // not turn a restart into an unpause.
      next.manager.recoverySweep();
      await settle();
      expect(stateOf(runId)).toBe('queued');
    } finally {
      await next.server.close();
    }
  });

  it('comes back running once resumed, so the flag is not sticky', async () => {
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));
    await app.inject(auth({ method: 'POST', url: '/resume' }));

    const next = await restartDaemon();
    try {
      expect(next.manager.isPaused()).toBe(false);
    } finally {
      await next.server.close();
    }
  });
});

describe('health and diagnostics read the same flag as the queue', () => {
  it('reports paused across /health, /widget/snapshot and /support/bundle', async () => {
    await app.inject(auth({ method: 'POST', url: '/pause-all' }));

    expect((await app.inject(auth({ method: 'GET', url: '/health' }))).json().paused).toBe(true);
    expect((await app.inject(auth({ method: 'GET', url: '/widget/snapshot' }))).json().paused).toBe(true);
    expect(
      (await app.inject(auth({ method: 'GET', url: '/support/bundle' }))).json().scheduling.paused,
    ).toBe(true);

    // and the manager — the thing that actually decides — agrees
    expect(rm.isPaused()).toBe(true);
  });
});
