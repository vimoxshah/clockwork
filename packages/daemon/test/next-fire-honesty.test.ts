/**
 * The header's "next run" has to be a run that will actually happen.
 *
 * The bug: /health and /widget/snapshot resolved the next fire with
 * `WHERE enabled=1 AND next_fire IS NOT NULL` against `schedules` alone, while
 * `Scheduler.tick` also requires `tasks.enabled=1 AND tasks.deleted_at IS NULL`.
 * The header's predicate was therefore strictly weaker than the scheduler's, and
 * the gap is not hypothetical: deleting or disabling a task leaves its schedule
 * row `enabled=1` carrying a materialized `next_fire`, and nothing ever advances
 * that timestamp again, precisely because the tick is right to refuse it.
 *
 * So the stamp froze in the past and stayed there. A real report read
 * `next 22 Aug at 9:52 AM` on 7 Sep with nothing scheduled at all — the app
 * naming a time that had already gone by and could never move.
 *
 * The invariant pinned here is a relationship, not a value: whatever the header
 * advertises, the tick's own query must agree is firable. `tickCandidate` below
 * is a copy of that predicate, so a future divergence fails here instead of
 * shipping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let dir: string;
let db: DB;
let clock: FakeClock;
let app: FastifyInstance;
let token: string;
let realHome: string | undefined;

const auth = (json: Record<string, unknown>): Record<string, unknown> => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

/**
 * `Scheduler.tick`'s due-selection predicate, minus the `next_fire <= now`
 * bound. If the header can name a schedule this returns nothing for, the header
 * is lying.
 */
function tickCandidate(): number | null {
  const row = db
    .prepare(
      `SELECT MIN(s.next_fire) nf FROM schedules s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.enabled=1 AND t.enabled=1 AND t.deleted_at IS NULL AND s.next_fire IS NOT NULL`,
    )
    .get() as { nf: number | null };
  return row.nf;
}

function seedTask(over: Record<string, unknown> = {}): string {
  const now = clock.now();
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    'Next-fire probe',
    'do things',
    now,
    now,
  );
  const cols = Object.keys(over);
  if (cols.length > 0) {
    db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...cols.map((c) => over[c]),
      taskId,
    );
  }
  return taskId;
}

function seedSchedule(taskId: string, nextFire: number | null, enabled = 1): void {
  db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, 'rrule', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', NULL, NULL, 'UTC', ?, ?)`,
  ).run(`sched-${Math.random().toString(36).slice(2, 8)}`, taskId, nextFire, enabled);
}

const healthNextFire = async (): Promise<number | null> => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  return res.json().nextFire as number | null;
};

const trayNextRun = async (): Promise<{ next_fire: number; name: string } | null> => {
  const res = await app.inject(auth({ method: 'GET', url: '/widget/snapshot' }));
  expect(res.statusCode, res.body).toBe(200);
  return res.json().nextRun as { next_fire: number; name: string } | null;
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-next-fire-'));
  realHome = process.env.HOME;
  process.env.HOME = dir;
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(Date.now());
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
});

afterEach(async () => {
  await app.close();
  db.close();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('the "next run" stamp never names a run the scheduler will not fire', () => {
  it('ignores a soft-deleted task holding a stale past next_fire — the 22-Aug-on-7-Sep report', async () => {
    const staleFire = clock.now() - 16 * 24 * 3600_000; // ~16 days ago
    const taskId = seedTask({ deleted_at: clock.now() });
    seedSchedule(taskId, staleFire);

    // The row is exactly the shape that produced the bug: schedule still
    // enabled, next_fire materialized, task gone.
    expect(db.prepare('SELECT COUNT(*) c FROM schedules WHERE enabled=1 AND next_fire IS NOT NULL').get()).toEqual({
      c: 1,
    });
    expect(tickCandidate()).toBeNull();

    expect(await healthNextFire()).toBeNull();
    expect(await trayNextRun()).toBeNull();
  });

  it('ignores a disabled task, whose next_fire is equally frozen', async () => {
    const taskId = seedTask({ enabled: 0 });
    seedSchedule(taskId, clock.now() - 3600_000);

    expect(tickCandidate()).toBeNull();
    expect(await healthNextFire()).toBeNull();
    expect(await trayNextRun()).toBeNull();
  });

  it('still reports a live task — the fix must not silence the real answer', async () => {
    const due = clock.now() + 3600_000;
    const taskId = seedTask();
    seedSchedule(taskId, due);

    expect(await healthNextFire()).toBe(due);
    expect((await trayNextRun())?.next_fire).toBe(due);
  });

  it('prefers the live task over an earlier dead one instead of reporting the dead one', async () => {
    // Ordering is where a LIMIT 1 query gets this wrong even with the join: the
    // dead schedule sorts first, so an unfiltered ORDER BY would return it.
    const dead = seedTask({ deleted_at: clock.now() });
    seedSchedule(dead, clock.now() - 30 * 24 * 3600_000);
    const live = seedTask();
    const due = clock.now() + 7200_000;
    seedSchedule(live, due);

    expect(await healthNextFire()).toBe(due);
    expect((await trayNextRun())?.next_fire).toBe(due);
  });

  it('agrees with the scheduler on every mix of live, disabled and deleted tasks', async () => {
    seedSchedule(seedTask({ deleted_at: clock.now() }), clock.now() - 5 * 24 * 3600_000);
    seedSchedule(seedTask({ enabled: 0 }), clock.now() - 2 * 24 * 3600_000);
    seedSchedule(seedTask(), clock.now() + 600_000, 0); // schedule itself disabled
    const due = clock.now() + 900_000;
    seedSchedule(seedTask(), due);

    expect(await healthNextFire()).toBe(tickCandidate());
    expect(await healthNextFire()).toBe(due);
  });
});
