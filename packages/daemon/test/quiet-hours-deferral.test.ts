/**
 * T1-8: the scheduler-reachability half of "quiet hours gets a setter".
 *
 * `quiet-hours.test.ts` covers the pure window-math functions
 * (`inQuietWindow`/`quietWindowEnd`) in isolation. This file proves the thing
 * those functions feed: a task whose `delivery_json.quietHours` a caller can
 * now actually set (see `quiet-hours-schema.test.ts`) makes the running
 * `Scheduler` defer a due fire and record the deferral, exactly as
 * `office-hours.test.ts` proves for F3 — same harness shape, same assertion
 * style, and since ADR-030 the same mechanism. This file originally asserted
 * that quiet hours PRE-CLAIMED a 'pending' row at the resume instant, which it
 * did, and which was the defect: the resume tick could not then win its own
 * claim, so the schedule was pinned there forever. Neither branch pre-claims
 * now. The full deferred-then-fires cycle is pinned by quiet-hours-resume.test.ts.
 *
 * New file, not an addition to `office-hours.test.ts` or any of the other
 * eleven F1–F12 feature suites `claims-honesty.test.ts` counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Scheduler, inQuietWindow, quietWindowEnd } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const NY = 'America/New_York';
/** Same wrapping window as quiet-hours.test.ts's own fixture. */
const QH = { startHour: 23, endHour: 7 };

/** Same construction as quiet-hours.test.ts's own `at()`, so both suites agree on what "inside the window" means. */
const at = (day: number, hour: number): number =>
  new Date(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`).getTime();

let db: DB;
let dir: string;

function seedTask(over: Partial<Record<string, unknown>> = {}): string {
  const now = Date.now();
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    taskId,
    over.name ?? 'Nightly sweep',
    'do things',
    now,
    now,
  );
  const cols = Object.keys(over).filter((k) => k !== 'name');
  if (cols.length > 0) {
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...cols.map((c) => over[c]), taskId);
  }
  return taskId;
}

function seedSchedule(taskId: string, sched: Record<string, unknown>): string {
  const id = `sched-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    taskId,
    sched.kind,
    sched.rrule ?? null,
    sched.cron ?? null,
    sched.runAt ?? null,
    sched.tz ?? 'UTC',
    sched.nextFire ?? null,
    sched.enabled === undefined ? 1 : sched.enabled ? 1 : 0,
  );
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-quiet-setter-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a task-level quietHours value the scheduler can now reach (T1-8)', () => {
  it('defers a due cron fire inside the window, leaves the resume instant unclaimed, and bumps next_fire', async () => {
    const fireAt = at(24, 3); // 03:00 UTC = 23:00 EDT — inside [23,7)
    const resumeAt = quietWindowEnd(fireAt, QH, NY);
    expect(inQuietWindow(fireAt, QH, NY)).toBe(true); // sanity: this instant IS inside the window

    const taskId = seedTask({ delivery_json: JSON.stringify({ osNotify: true, quietHours: QH }) });
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: fireAt });

    const enqueued: string[] = [];
    const scheduler = new Scheduler({
      db,
      clock: new FakeClock(fireAt),
      enqueueRun: (spec) => enqueued.push(spec.runId),
      notify: () => {},
    });
    await scheduler.tick();
    scheduler.stop();

    // 1. Nothing ran — the whole point of a quiet window.
    expect(enqueued).toHaveLength(0);

    // 2. The claimed occurrence at the original fire time reads 'deferred'.
    const original = db
      .prepare('SELECT disposition FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, fireAt) as { disposition: string };
    expect(original.disposition).toBe('deferred');

    // 3. The load-bearing rule (ADR-030): NOTHING is claimed at the resume
    //    instant. The tick that runs then has to win its own claim; a row
    //    pre-claimed here makes that claim a no-op, `if (!claimed) return`
    //    fires, and the schedule is pinned at the deferral forever. This
    //    assertion used to expect 'pending' — it was pinning the defect.
    const resumed = db
      .prepare('SELECT disposition FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, resumeAt) as { disposition: string } | undefined;
    expect(resumed, 'the resume instant must be left for its own tick to claim').toBeUndefined();

    // 4. next_fire is bumped to the resume instant so the tick loop revisits it.
    const row = db.prepare('SELECT next_fire FROM schedules WHERE id=?').get(scheduleId) as { next_fire: number | null };
    expect(row.next_fire).toBe(resumeAt);
  });

  it('does not defer a cron fire outside the window — quietHours is honoured, not always-on', async () => {
    const fireAt = at(24, 12); // 12:00 UTC = 08:00 EDT — outside [23,7)
    expect(inQuietWindow(fireAt, QH, NY)).toBe(false); // sanity

    const taskId = seedTask({ delivery_json: JSON.stringify({ osNotify: true, quietHours: QH }) });
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 12 * * *', tz: NY, nextFire: fireAt });

    const enqueued: string[] = [];
    const scheduler = new Scheduler({
      db,
      clock: new FakeClock(fireAt),
      enqueueRun: (spec) => enqueued.push(spec.runId),
      notify: () => {},
    });
    await scheduler.tick();
    scheduler.stop();

    expect(enqueued).toHaveLength(1);
    const occ = db
      .prepare('SELECT disposition FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, fireAt) as { disposition: string };
    expect(occ.disposition).toBe('fired');
  });
});
