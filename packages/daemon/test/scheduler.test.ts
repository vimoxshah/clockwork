/**
 * Fake-clock scheduler fixture suite (stack #16 fixture inventory #1).
 * Zones: America/New_York, Europe/Berlin, Australia/Lord_Howe, UTC.
 * Covers S-1, S-8, S-10, S-11, S-20, S-21, S-24, S-25 + double-fire attacks.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { openDatabase, createMigrator, type DB } from '../src/db.js';
import { readFileSync } from 'node:fs';
import { Scheduler, GRACE_MS, buildJobSpec } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';

let db: DB;
let dir: string;
let clock: FakeClock;
let enqueued: Array<{ runId: string; spec: any }>;
let notifications: Array<{ kind: string; taskName: string; detail: string }>;
let scheduler: Scheduler;

const MIGRATION = {
  id: '0001_init',
  sql: readFileSync(path.resolve(import.meta.dirname, '../migrations/0001_init.sql'), 'utf8'),
};

function seedTask(over: Partial<Record<string, unknown>> = {}): { taskId: string; scheduleId: string } {
  const now = clock.now();
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  const scheduleId = `sched-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, over.name ?? 'Test task', 'do things', now, now);
  const cols = Object.keys(over).filter((k) => !['name'].includes(k));
  if (cols.length > 0) {
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(...cols.map((c) => over[c]), taskId);
  }
  return { taskId, scheduleId };
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
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-sched-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, [MIGRATION]).migrate();
  // fake clock anchored at a safe instant
  clock = new FakeClock(DateTime.fromObject({ year: 2026, month: 3, day: 7, hour: 12 }, { zone: 'utc' }).toMillis());
  enqueued = [];
  notifications = [];
  scheduler = new Scheduler({
    db,
    clock,
    enqueueRun: (spec) => enqueued.push({ runId: spec.runId, spec }),
    notify: (kind, taskName, detail) => notifications.push({ kind, taskName, detail }),
  });
});

afterEach(() => {
  scheduler.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('S-1 one-off firing', () => {
  it('fires within the tick when next_fire passes', async () => {
    const fireAt = clock.now() + 60_000;
    const { taskId } = seedTask();
    seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });

    await scheduler.tick();
    expect(enqueued).toHaveLength(0); // not due yet

    clock.advance(61_000);
    await scheduler.tick();
    expect(enqueued).toHaveLength(1);
    const row = db.prepare('SELECT state FROM runs').get() as any;
    expect(row.state).toBe('queued');
    // once schedules clear their next_fire
    const s = db.prepare('SELECT next_fire FROM schedules').get() as any;
    expect(s.next_fire).toBeNull();
  });
});

describe('double-fire attack (the ledger)', () => {
  it('concurrent claim transactions cannot produce two runs for one occurrence', async () => {
    const fireAt = clock.now() - 1000; // already due
    const { taskId } = seedTask();
    const scheduleId = seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });

    // Two schedulers racing on the SAME db — same serialization point as two processes on SQLite.
    const s2 = new Scheduler({
      db,
      clock,
      enqueueRun: (spec) => enqueued.push({ runId: spec.runId, spec }),
      notify: () => {},
    });
    await Promise.all([scheduler.tick(), s2.tick()]);
    const runs = db.prepare('SELECT COUNT(*) c FROM runs').get() as any;
    expect(runs.c).toBe(1);
    const occs = db.prepare('SELECT COUNT(*) c FROM schedule_occurrences').get() as any;
    expect(occs.c).toBe(1);
    void scheduleId;
  });

  it('backward clock jump does NOT re-fire completed occurrences (S-25)', async () => {
    const fireAt = clock.now() + 30_000;
    const { taskId } = seedTask();
    seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });
    clock.advance(31_000);
    await scheduler.tick();
    expect(enqueued).toHaveLength(1);
    // NTP-style backward jump of 10 minutes:
    clock.setTo(clock.now() - 600_000);
    await scheduler.tick();
    await scheduler.tick();
    expect(enqueued).toHaveLength(1); // never re-fired
  });
});

describe('DST fixtures across zones (S-20/S-21)', () => {
  // US spring-forward 2026-03-08: 02:30 local does not exist in America/New_York
  it('America/New_York: nonexistent 02:30 fires at post-transition instant', async () => {
    const { wallTimeToUtcMs } = await import('../src/recurrence.js');
    const wall = DateTime.fromObject({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, { zone: 'utc' });
    const utcMs = wallTimeToUtcMs(wall, 'America/New_York');
    const inZone = DateTime.fromMillis(utcMs, { zone: 'America/New_York' });
    // post-transition instant: clocks jumped to 03:00, so effective local time >= 03:00
    expect(inZone.hour * 60 + inZone.minute).toBeGreaterThanOrEqual(3 * 60);
  });

  it('Europe/Berlin spring-forward (2026-03-29 02:30 nonexistent) resolves forward', async () => {
    const { wallTimeToUtcMs } = await import('../src/recurrence.js');
    const wall = DateTime.fromObject({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, { zone: 'utc' });
    const utcMs = wallTimeToUtcMs(wall, 'Europe/Berlin');
    const inZone = DateTime.fromMillis(utcMs, { zone: 'Europe/Berlin' });
    expect(inZone.hour * 60 + inZone.minute).toBeGreaterThanOrEqual(3 * 60);
  });

  it('Australia/Lord_Howe (+30min offset zone) half-hour DST handled without crash', async () => {
    const { wallTimeToUtcMs } = await import('../src/recurrence.js');
    // Lord Howe spring-forward 2025-10-05 02:15 -> 03:00 (+30min shift at 02:00→02:30 skip)
    const wall = DateTime.fromObject({ year: 2025, month: 10, day: 5, hour: 2, minute: 15 }, { zone: 'utc' });
    const utcMs = wallTimeToUtcMs(wall, 'Australia/Lord_Howe');
    expect(Number.isFinite(utcMs)).toBe(true);
    const inZone = DateTime.fromMillis(utcMs, { zone: 'Australia/Lord_Howe' });
    expect(inZone.isValid).toBe(true);
  });

  it('fall-back ambiguous time fires on FIRST occurrence only (US 2026-11-01 01:30 ET)', async () => {
    const { wallTimeToUtcMs } = await import('../src/recurrence.js');
    const wall = DateTime.fromObject({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, { zone: 'utc' });
    const utcMs = wallTimeToUtcMs(wall, 'America/New_York');
    const inZone = DateTime.fromMillis(utcMs, { zone: 'America/New_York' });
    // first occurrence = EDT (UTC-4): UTC time should be 05:30Z, not 06:30Z
    expect(inZone.toUTC().hour).toBe(5);
    expect(inZone.offsetNameShort).toContain('EDT');
  });

  it('weekly recurring task expands correctly across a DST boundary (Berlin)', async () => {
    // Sundays 09:30 Berlin — spans Mar 29 2026 spring-forward
    const { taskId } = seedTask();
    const before = DateTime.fromObject({ year: 2026, month: 3, day: 22, hour: 9, minute: 30 }, { zone: 'Europe/Berlin' }).toMillis();
    const scheduleId = seedSchedule(taskId, {
      kind: 'rrule',
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=30',
      tz: 'Europe/Berlin',
      nextFire: before,
    });
    void scheduleId;
    clock.setTo(before + 1000); // just past the Sunday 09:30 fire
    await scheduler.tick();
    expect(enqueued).toHaveLength(1);
    // after firing, next_fire must be the NEXT Sunday with correct local wall time
    const s = db.prepare('SELECT next_fire FROM schedules WHERE enabled=1').get() as any;
    expect(s.next_fire).not.toBeNull();
    const nextLocal = DateTime.fromMillis(s.next_fire, { zone: 'Europe/Berlin' });
    expect(nextLocal.weekday).toBe(7); // Sunday
    expect(nextLocal.hour).toBe(9);
    expect(nextLocal.minute).toBe(30);
  });
});

describe('sleep catch-up + coalescing (S-10/S-11)', () => {
  function dailyTask(missedPolicy = 'run-late', missedWindowSec = 21_600) {
    const { taskId } = seedTask({ missed_policy: missedPolicy, missed_window_sec: missedWindowSec });
    // daily 02:00 UTC starting Mar 6
    const start = DateTime.fromObject({ year: 2026, month: 3, day: 6, hour: 2 }, { zone: 'utc' }).toMillis();
    seedSchedule(taskId, {
      kind: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
      tz: 'UTC',
      nextFire: start,
    });
    return { taskId, firstFire: start };
  }

  it('S-10 wake 20 min late, policy=run-late → exactly one late run', async () => {
    const { firstFire } = dailyTask('run-late');
    clock.setTo(firstFire + 20 * 60_000); // slept through, wake 20m late
    await scheduler.tick();
    expect(enqueued).toHaveLength(1);
    const occ = db.prepare("SELECT disposition FROM schedule_occurrences").get() as any;
    expect(occ.disposition).toBe('fired');
  });

  it('S-10 policy=skip beyond window → missed disposition + notification, no run', async () => {
    const { taskId, firstFire } = dailyTask('skip');
    db.prepare('UPDATE tasks SET missed_window_sec=? WHERE id=?').run(900, taskId); // 15min window
    clock.setTo(firstFire + 20 * 60_000);
    await scheduler.tick();
    expect(enqueued).toHaveLength(0);
    const occ = db.prepare('SELECT disposition FROM schedule_occurrences').get() as any;
    expect(occ.disposition).toBe('missed');
    expect(notifications.some((n) => n.kind === 'missed')).toBe(true);
  });

  it('S-11 weekend sleep over TWO occurrences → ONE catch-up run, others coalesced, next_fire forward', async () => {
    const { firstFire } = dailyTask('run-late', 7 * 86_400); // wide window so run-late applies
    // sleep from before occurrence 1 to just past occurrence 2
    clock.setTo(firstFire + 24 * 3600_000 + 5 * 60_000); // 24h5m later → 2 occurrences passed
    await scheduler.tick();
    expect(enqueued).toHaveLength(1); // coalescing rule: max ONE catch-up
    const occs = db.prepare('SELECT disposition, occurrence_at FROM schedule_occurrences ORDER BY occurrence_at').all() as any[];
    expect(occs.length).toBe(2);
    expect(occs.filter((o) => o.disposition === 'coalesced')).toHaveLength(1);
    // next_fire materialized FORWARD past both
    const s = db.prepare('SELECT next_fire FROM schedules WHERE enabled=1').get() as any;
    expect(s.next_fire).toBeGreaterThan(clock.now());
  });

  it('S-11b sleeping over FIVE occurrences still produces only ONE catch-up', async () => {
    const { firstFire } = dailyTask('run-late', 30 * 86_400);
    clock.setTo(firstFire + 5 * 24 * 3600_000 + 5 * 60_000);
    await scheduler.tick();
    expect(enqueued).toHaveLength(1);
    const occs = db.prepare('SELECT disposition FROM schedule_occurrences').all() as any[];
    expect(occs.length).toBe(6); // Mar 6..11 inclusive
    expect(occs.filter((o) => o.disposition === 'fired')).toHaveLength(1);
    expect(occs.filter((o) => o.disposition === 'coalesced')).toHaveLength(5);
  });

  it('policy=ask creates awaiting_user item (FSM)', async () => {
    const { firstFire } = dailyTask('ask');
    db.prepare('UPDATE tasks SET missed_window_sec=? WHERE id=?').run(600, taskIdHelper());
    function taskIdHelper() {
      return (db.prepare('SELECT id FROM tasks LIMIT 1') as any).get().id as string;
    }
    clock.setTo(firstFire + 20 * 60_000);
    await scheduler.tick();
    expect(enqueued).toHaveLength(0);
    const run = db.prepare("SELECT state FROM runs").get() as any;
    expect(run.state).toBe('awaiting_user');
  });
});

describe('S-24 RRULE exhaustion auto-disables', () => {
  it('COUNT-exhausted rule disables itself and notifies once', async () => {
    const { taskId } = seedTask();
    const fireAt = clock.now() + 1000;
    seedSchedule(taskId, { kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=1;BYHOUR=12', tz: 'UTC', nextFire: fireAt });
    clock.setTo(fireAt + GRACE_MS + 1000);
    await scheduler.tick();
    const s = db.prepare('SELECT enabled, next_fire FROM schedules').get() as any;
    expect(s.enabled).toBe(0);
    expect(s.next_fire).toBeNull();
    expect(notifications.some((n) => n.kind === 'auto_disabled')).toBe(true);
  });
});

describe('S-8 overlap policy', () => {
  it('skip policy: due occurrence is skipped while previous run is active', async () => {
    const { taskId } = seedTask({ overlap_policy: 'skip' });
    const activeRun = `active-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, ?, '{}', 'running', ?)`,
    ).run(activeRun, taskId, clock.now());

    const fireAt = clock.now() - 1000;
    seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });
    await scheduler.tick();
    expect(enqueued).toHaveLength(0);
    const occ = db.prepare('SELECT disposition FROM schedule_occurrences').get() as any;
    expect(occ.disposition).toBe('skipped');
  });

  it('queue policy: second instance queues behind repo mutex instead of skipping', async () => {
    const { taskId } = seedTask({ overlap_policy: 'queue' });
    const activeRun = `active-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at) VALUES (?, ?, '{}', 'running', ?)`,
    ).run(activeRun, taskId, clock.now());
    const fireAt = clock.now() - 1000;
    seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });
    await scheduler.tick();
    expect(enqueued).toHaveLength(1); // queued despite overlap
  });
});

describe('S-9 scale sanity', () => {
  it('500 tasks, 50 due — tick processes all due and stays responsive', async () => {
    for (let i = 0; i < 450; i++) {
      const { taskId } = seedTask({ name: `idle-${i}` });
      seedSchedule(taskId, { kind: 'once', runAt: clock.now() + 3_600_000, tz: 'UTC', nextFire: clock.now() + 3_600_000 });
    }
    for (let i = 0; i < 50; i++) {
      const { taskId } = seedTask({ name: `due-${i}` });
      seedSchedule(taskId, { kind: 'once', runAt: clock.now() - i - 1, tz: 'UTC', nextFire: clock.now() - i - 1 });
    }
    const t0 = Date.now();
    await scheduler.tick();
    expect(Date.now() - t0).toBeLessThan(5000); // generous CI bound; real budget is far lower
    expect(enqueued.length).toBe(50);
  });
});

describe('jobspec snapshot (S-5)', () => {
  it('captured spec survives later task edits', async () => {
    const { taskId } = seedTask({ name: 'snapshot-task' });
    const fireAt = clock.now() + 1000;
    seedSchedule(taskId, { kind: 'once', runAt: fireAt, tz: 'UTC', nextFire: fireAt });
    clock.advance(2000);
    await scheduler.tick();
    // edit AFTER enqueue
    db.prepare('UPDATE tasks SET prompt=? WHERE id=?').run('EDITED PROMPT', taskId);
    const row = db.prepare('SELECT jobspec_json FROM runs').get() as any;
    const spec = JSON.parse(row.jobspec_json);
    expect(spec.prompt).toBe('do things'); // frozen snapshot
    expect(spec.branch.startsWith('clockwork/snapshot-task/')).toBe(true);
    expect(buildJobSpec(spec.runId, {
      ...({} as any),
      name: 'snapshot-task', prompt: 'x', profile_id: null, repo_path: null, model: null,
      permission_mode: 'acceptEdits', budget_usd: 2, max_turns: 50, timeout_sec: 3600,
      base_branch: null, context_json: '[]', delivery_json: '{}', missed_policy: 'run-late',
      missed_window_sec: 21600, overlap_policy: 'skip', retry_on_transient: 0, enabled: 1,
      version: 1, deleted_at: null,
    }, clock.now(), fireAt, db).branch.startsWith('clockwork/')).toBe(true);
  });
});
