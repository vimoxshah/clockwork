/**
 * Quiet hours, the second half: what happens when the window ENDS.
 *
 * `quiet-hours.test.ts` covers the pure window math and
 * `quiet-hours-deferral.test.ts` covers the deferral itself. Neither follows
 * the occurrence past the deferral, and that is where quiet hours was broken:
 * the branch pre-claimed a `pending` ledger row at the resume instant, so the
 * tick that arrived there lost its own `INSERT OR IGNORE` claim on
 * `PRIMARY KEY (schedule_id, occurrence_at)`, hit `if (!claimed) return`, and
 * enqueued nothing — leaving `next_fire` parked at a resume instant that was
 * now in the past, on every subsequent tick, forever.
 *
 * ADR-038 states that exact failure as the reason office hours (F3)
 * deliberately does NOT pre-claim; ADR-030 was never written, so nothing
 * argued the other way for quiet hours. These fixtures pin the corrected
 * behaviour: deferral unchanged, and the deferred run actually fires.
 *
 * New sibling file on purpose — not an addition to any of the twelve F1–F12
 * suites `claims-honesty.test.ts` counts, and it modifies neither
 * `quiet-hours.test.ts` nor the 18 `scheduler.test.ts` fixtures.
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
/** The same midnight-wrapping window `quiet-hours.test.ts` uses. */
const QH = { startHour: 23, endHour: 7 };
/** One scheduler tick, so "the tick after the resume tick" is a real instant. */
const TICK_MS = 30_000;

/** Same construction as the sibling suites', so all three agree on "inside the window". */
const at = (day: number, hour: number): number =>
  new Date(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`).getTime();

let db: DB;
let dir: string;
let clock: FakeClock;
let enqueued: string[];
let notes: Array<{ kind: string; detail: string }>;
let scheduler: Scheduler;

function seedQuietTask(): string {
  const now = clock.now();
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    taskId,
    'Nightly sweep',
    'do things',
    now,
    now,
  );
  db.prepare(`UPDATE tasks SET delivery_json = ? WHERE id = ?`).run(
    JSON.stringify({ osNotify: true, quietHours: QH }),
    taskId,
  );
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

const nextFireOf = (scheduleId: string): number | null =>
  (db.prepare('SELECT next_fire FROM schedules WHERE id=?').get(scheduleId) as { next_fire: number | null }).next_fire;

const occurrenceAt = (scheduleId: string, occurrence: number): { disposition: string; run_id: string | null } | undefined =>
  db
    .prepare('SELECT disposition, run_id FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
    .get(scheduleId, occurrence) as { disposition: string; run_id: string | null } | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-quiet-resume-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(at(24, 3));
  enqueued = [];
  notes = [];
  scheduler = new Scheduler({
    db,
    clock,
    enqueueRun: (spec) => enqueued.push(spec.runId),
    notify: (kind, _taskName, detail) => notes.push({ kind, detail }),
  });
});

afterEach(() => {
  scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a fire deferred by quiet hours actually runs when the window ends', () => {
  /** 03:00 UTC = 23:00 EDT — the first instant inside [23,7). */
  const fireAt = at(24, 3);
  const resumeAt = quietWindowEnd(fireAt, QH, NY);

  it('sanity: the fixture instants really are inside and outside the window', () => {
    expect(inQuietWindow(fireAt, QH, NY)).toBe(true);
    expect(inQuietWindow(resumeAt, QH, NY)).toBe(false);
    expect(resumeAt).toBeGreaterThan(fireAt);
  });

  it('enqueues the run at the resume instant — the deferral is a delay, not a cancellation', async () => {
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: fireAt });

    clock.setTo(fireAt);
    await scheduler.tick();
    expect(enqueued, 'the fire inside the window must not run').toHaveLength(0);
    expect(nextFireOf(scheduleId), 'next_fire must point at the resume instant').toBe(resumeAt);

    // The whole point: the tick at the resume instant has to produce a run.
    clock.setTo(resumeAt);
    await scheduler.tick();
    expect(enqueued, 'the deferred occurrence never fired when its window ended').toHaveLength(1);

    const resumed = occurrenceAt(scheduleId, resumeAt);
    expect(resumed?.disposition).toBe('fired');
    expect(resumed?.run_id).toBe(enqueued[0]);

    const run = db.prepare('SELECT occurrence_at, state FROM runs WHERE id=?').get(enqueued[0]) as
      | { occurrence_at: number; state: string }
      | undefined;
    expect(run?.occurrence_at).toBe(resumeAt);
    expect(run?.state).toBe('queued');
  });

  it('leaves no pre-claimed ledger row at the resume instant for the resume tick to lose its claim to', async () => {
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: fireAt });

    clock.setTo(fireAt);
    await scheduler.tick();

    // A row here would make the resume tick's INSERT OR IGNORE a no-op on
    // PRIMARY KEY (schedule_id, occurrence_at) — ADR-038's stated hazard.
    expect(
      occurrenceAt(scheduleId, resumeAt),
      'the resume instant is pre-claimed; the tick that arrives there cannot win its own claim',
    ).toBeUndefined();
  });

  it('moves next_fire past the resume instant instead of pinning the schedule there', async () => {
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: fireAt });

    clock.setTo(fireAt);
    await scheduler.tick();
    clock.setTo(resumeAt);
    await scheduler.tick();

    expect(nextFireOf(scheduleId), 'next_fire is still parked at the resume instant').toBeGreaterThan(resumeAt);

    // A schedule pinned in the past is re-picked by every later tick.
    clock.setTo(resumeAt + TICK_MS);
    await scheduler.tick();
    clock.setTo(resumeAt + 2 * TICK_MS);
    await scheduler.tick();
    expect(enqueued, 'the resume instant fired more than once, or not at all').toHaveLength(1);
  });

  it("a 'once' schedule deferred into the window still fires — its next_fire is not left NULL", async () => {
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: NY, nextFire: fireAt });

    clock.setTo(fireAt);
    await scheduler.tick();
    expect(enqueued).toHaveLength(0);
    expect(occurrenceAt(scheduleId, fireAt)?.disposition).toBe('deferred');
    // The claim transaction NULLs a one-shot's next_fire. Without a bump here
    // the tick loop's `next_fire IS NOT NULL` filter never sees this schedule
    // again and the one-shot is lost work, not a skipped repeat (ADR-038).
    expect(nextFireOf(scheduleId), 'the one-shot is unreachable: next_fire was left NULL').toBe(resumeAt);

    clock.setTo(resumeAt);
    await scheduler.tick();
    expect(enqueued, 'the deferred one-shot never ran').toHaveLength(1);
    expect(occurrenceAt(scheduleId, resumeAt)?.disposition).toBe('fired');
    expect(nextFireOf(scheduleId), 'a fired one-shot must retire').toBeNull();

    clock.setTo(resumeAt + TICK_MS);
    await scheduler.tick();
    expect(enqueued, 'the one-shot ran twice').toHaveLength(1);
  });
});

describe('the deferral itself is unchanged', () => {
  const fireAt = at(24, 3);
  const resumeAt = quietWindowEnd(fireAt, QH, NY);

  it('defers a due fire inside the window: no run, occurrence marked deferred, one inbox note', async () => {
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: fireAt });

    clock.setTo(fireAt);
    await scheduler.tick();

    expect(enqueued).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM runs').get()).toEqual({ c: 0 });
    expect(occurrenceAt(scheduleId, fireAt)?.disposition).toBe('deferred');
    expect(occurrenceAt(scheduleId, fireAt)?.run_id).toBeNull();
    expect(nextFireOf(scheduleId)).toBe(resumeAt);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('missed');
    expect(notes[0]!.detail).toMatch(/Deferred past quiet hours/);
  });

  it('does not defer a fire outside the window', async () => {
    const outside = at(24, 12); // 08:00 EDT — just past the end of [23,7)
    expect(inQuietWindow(outside, QH, NY)).toBe(false);
    const taskId = seedQuietTask();
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 12 * * *', tz: NY, nextFire: outside });

    clock.setTo(outside);
    await scheduler.tick();

    expect(enqueued).toHaveLength(1);
    expect(occurrenceAt(scheduleId, outside)?.disposition).toBe('fired');
    expect(notes).toHaveLength(0);
  });

  it('leaves a task with no quietHours configured completely alone', async () => {
    const now = at(24, 3);
    const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      taskId,
      'No quiet hours',
      'do things',
      now,
      now,
    );
    const scheduleId = seedSchedule(taskId, { kind: 'cron', cron: '0 23 * * *', tz: NY, nextFire: now });

    clock.setTo(now);
    await scheduler.tick();

    expect(enqueued).toHaveLength(1);
    expect(occurrenceAt(scheduleId, now)?.disposition).toBe('fired');
  });
});
