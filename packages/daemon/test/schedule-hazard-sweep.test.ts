/**
 * The startup repair for schedules saved before `guardSchedule` existed (T1-12).
 *
 * The hole this closes is narrow and real. `guardSchedule` refuses hazardous
 * recurrences AT SAVE (`api.ts:800`), and the tick path is deliberately left
 * unguarded — `api.ts:786` says why: a stored row "would go from slow to
 * throwing, and that is a different change from refusing new ones". Right
 * about the tick, and it leaves every install that already carries such a row
 * with a daemon that can hang on it and nothing to say so.
 *
 * `FREQ=HOURLY;INTERVAL=2;BYHOUR=3` is the shape: its hours stay even, hour 3
 * is never reached, and rrule 2.8.1's skip loop never terminates. That is not
 * asserted here — `schedule-guard.test.ts` pins it, out-of-process with a
 * 12-second watchdog — because a suite that proved it by running it would
 * never finish. What IS asserted here is the consequence: after the sweep, a
 * real `Scheduler.tick()` over the same database RETURNS.
 *
 * Every timing bound below is about termination, not speed. The alternative to
 * "fast" here is not "slow", it is "never", so the numbers are loose on
 * purpose; their job is to fail if someone ever makes this sweep expand a rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { sweepHazardousSchedules } from '../src/main.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const MAIN_SRC = path.resolve(import.meta.dirname, '../src/main.ts');

/** The documented hang. Never expanded in this file — only classified. */
const HAZARD = 'FREQ=HOURLY;INTERVAL=2;BYHOUR=3';
/** The same intent, on a grid the walk actually reaches. */
const SAFE = 'FREQ=HOURLY;INTERVAL=1;BYHOUR=3';

let db: DB;
let dir: string;
let clock: FakeClock;
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

interface SeedOpts {
  name?: string;
  kind?: 'rrule' | 'cron' | 'once';
  rrule?: string | null;
  cron?: string | null;
  runAt?: number | null;
  nextFire?: number | null;
  scheduleEnabled?: boolean;
  taskEnabled?: boolean;
  deleted?: boolean;
  contextJson?: string;
}

function seed(opts: SeedOpts = {}): { taskId: string; scheduleId: string } {
  const taskId = `task-${Math.random().toString(36).slice(2, 10)}`;
  const scheduleId = `sched-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, enabled, deleted_at, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    opts.name ?? 'Nightly repo digest',
    'Summarize what changed.',
    opts.taskEnabled === false ? 0 : 1,
    opts.deleted ? NOW - 86_400_000 : null,
    opts.contextJson ?? '[]',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?)`,
  ).run(
    scheduleId,
    taskId,
    opts.kind ?? 'rrule',
    opts.rrule === undefined ? HAZARD : opts.rrule,
    opts.cron ?? null,
    opts.runAt ?? null,
    opts.nextFire === undefined ? NOW : opts.nextFire,
    opts.scheduleEnabled === false ? 0 : 1,
  );
  return { taskId, scheduleId };
}

type ScheduleState = { enabled: number; next_fire: number | null };
const schedule = (id: string): ScheduleState =>
  db.prepare('SELECT enabled, next_fire FROM schedules WHERE id=?').get(id) as unknown as ScheduleState;

type NoticeRun = { id: string; state: string; outcome_reason: string | null; report_json: string | null; jobspec_json: string };
const runsFor = (taskId: string): NoticeRun[] =>
  db.prepare('SELECT id, state, outcome_reason, report_json, jobspec_json FROM runs WHERE task_id=?').all(taskId) as unknown as NoticeRun[];

type AuditRow = { target_id: string; detail_json: string };
const auditRows = (): AuditRow[] =>
  db.prepare(`SELECT target_id, detail_json FROM audit_log WHERE action='schedule.hazard_disabled'`).all() as unknown as AuditRow[];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-hazard-sweep-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a database carrying a pre-guard hazardous recurrence', () => {
  it('disables the row, and the sweep returns instead of expanding it', () => {
    const { scheduleId } = seed();

    const t0 = performance.now();
    const result = sweepHazardousSchedules(db, NOW, () => {});
    const elapsed = performance.now() - t0;

    expect(result.checked).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.disabled).toHaveLength(1);
    expect(result.disabled[0]).toMatchObject({ scheduleId, rrule: HAZARD, reason: 'unreachable' });
    expect(schedule(scheduleId)).toMatchObject({ enabled: 0, next_fire: null });
    // Termination, not speed: the rule itself never returns from rrule, so any
    // finite time proves the sweep decided from the string. A regression that
    // put an expansion back in this loop would blow through this by orders of
    // magnitude or never arrive at all.
    expect(elapsed).toBeLessThan(1000);
  });

  it('raises an inbox item naming the task, the rule and the fix the guard composed', () => {
    const { taskId } = seed({ name: 'Every other hour at three' });

    sweepHazardousSchedules(db, NOW, () => {});

    const runs = runsFor(taskId);
    expect(runs).toHaveLength(1);
    // `awaiting_user` is what the Inbox's "Needs you" filter matches on
    // (InboxView.tsx:59) and what the scheduler already uses for a placeholder
    // run that exists only to ask a human something (scheduler.ts:158).
    expect(runs[0]!.state).toBe('awaiting_user');
    expect(runs[0]!.outcome_reason).toBe('schedule_hazard');
    // The inbox list reads the task name out of the jobspec, so it has to be
    // a well-formed one rather than a stub.
    expect(JSON.parse(runs[0]!.jobspec_json).taskName).toBe('Every other hour at three');

    const summary = JSON.parse(runs[0]!.report_json!).summary as string;
    expect(summary).toContain('Every other hour at three');
    expect(summary).toContain(HAZARD);
    // The guard's own remedy sentence, reused verbatim rather than reworded.
    expect(summary).toContain('Pick an interval that divides 24, or a start time on the same grid.');
    expect(summary).toContain("Clockwork disabled this task's schedule at startup");
  });

  it('records the reason in the append-only audit log, beside the inbox item', () => {
    const { scheduleId } = seed();

    sweepHazardousSchedules(db, NOW, () => {});

    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(scheduleId);
    const detail = JSON.parse(audit[0]!.detail_json);
    expect(detail).toMatchObject({ rrule: HAZARD, reason: 'unreachable' });
    expect(detail.detail).toContain('never terminate');
    // The two records point at each other. Retention does NOT reap the
    // notice — `RetentionAudit.sweep` only deletes terminal-state runs
    // (retention-audit.ts:79) and `awaiting_user` is not terminal — so this
    // row is a second, machine-readable record rather than a survivor.
    expect(detail.runId).toBe(runsFor(detail.taskId)[0]!.id);
  });

  it('says what it did, once, in one line', () => {
    seed();
    const lines: string[] = [];

    sweepHazardousSchedules(db, NOW, (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[schedule-sweep] checked 1 recurring schedule(s) and disabled 1 that rrule 2.8.1 cannot expand; '
        + 'each disabled task has an inbox item naming its rule and the fix. Fix the recurrence and save '
        + 'the task to switch it back on.',
    );
  });

  it('refuses every verdict the guard refuses, not only the unreachable ones', () => {
    // The guard's verdict IS the definition of hazardous here. Filtering by
    // reason would be re-tuning an analysis this sweep is meant to reuse.
    const a = seed({ name: 'huge count', rrule: 'FREQ=DAILY;COUNT=40000000' });
    const b = seed({ name: 'no freq at all', rrule: 'INTERVAL=2;BYHOUR=3' });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.disabled.map((d) => d.reason).sort()).toEqual(['count_too_large', 'unparseable']);
    expect(schedule(a.scheduleId).enabled).toBe(0);
    expect(schedule(b.scheduleId).enabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the boot completes, which is the whole point', () => {
  it('a real scheduler tick over the repaired database returns, and enqueues nothing for the bad row', async () => {
    const hazard = seed({ name: 'the hang' });
    // Negative control: an identically-shaped SAFE row, due at the same
    // instant. It proves the tick genuinely expands STORED rules — so the
    // hazardous row above really was on the path that never returns — and
    // that the sweep did not simply switch the scheduler off.
    const safe = seed({ name: 'the control', rrule: SAFE, nextFire: NOW });

    sweepHazardousSchedules(db, NOW, () => {});

    // FAIL FAST RATHER THAN HANG, and this guard is not decoration. Removing
    // the sweep's `UPDATE schedules SET enabled=0` and re-running this file
    // does not produce a red test — it blocks forever, inside
    // `nextOccurrenceAfter` on the rule below, which is the defect T1-12
    // exists to remove. Measured here: killed by hand after 2m20s of 98% CPU
    // with no output. So the state the tick depends on is asserted BEFORE the
    // tick, and a regression is a failure a person can read.
    expect(
      schedule(hazard.scheduleId),
      'the sweep left the hazardous row armed — the tick below would never return',
    ).toMatchObject({ enabled: 0, next_fire: null });

    const enqueued: string[] = [];
    const scheduler = new Scheduler({
      db,
      clock,
      enqueueRun: (spec) => enqueued.push(spec.taskId),
      notify: () => {},
    });
    const t0 = performance.now();
    await scheduler.tick();
    const elapsed = performance.now() - t0;
    scheduler.stop();

    expect(enqueued).toEqual([safe.taskId]);
    expect(enqueued).not.toContain(hazard.taskId);
    // The control's next_fire moved on, so the expander really did run.
    expect(schedule(safe.scheduleId).next_fire).toBeGreaterThan(NOW);
    expect(elapsed).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------

describe('idempotency across boots', () => {
  it('a second boot raises nothing: the disable IS the marker', () => {
    const { taskId } = seed();

    const first = sweepHazardousSchedules(db, NOW, () => {});
    const second = sweepHazardousSchedules(db, NOW + 60_000, () => {});

    expect(first.disabled).toHaveLength(1);
    expect(second.checked).toBe(0);
    expect(second.disabled).toEqual([]);
    expect(runsFor(taskId)).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it('ten boots produce one inbox item', () => {
    const { taskId } = seed();
    for (let i = 0; i < 10; i++) sweepHazardousSchedules(db, NOW + i * 60_000, () => {});
    expect(runsFor(taskId)).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it('repairs a row that came back to enabled=1, and tells the user again', () => {
    // DELIBERATE. `schedules.enabled` has exactly one writer that can set it to
    // 1 — `TaskRepo.patch` (repo.ts:186) — and it is reached only when the
    // request carries a `schedule`, which `validateAndMaterialize` puts through
    // this same guard first. Re-enabling the TASK
    // (`PATCH /tasks/:id {enabled:true}`) never touches the schedule row. So a
    // hazardous `enabled=1` row at boot is never a validated user choice, and
    // honouring it would hand the daemon back the hang. It is repaired again
    // and re-reported — told, not silently overruled.
    const { taskId, scheduleId } = seed();
    sweepHazardousSchedules(db, NOW, () => {});
    db.prepare('UPDATE schedules SET enabled=1, next_fire=? WHERE id=?').run(NOW + 3_600_000, scheduleId);

    const again = sweepHazardousSchedules(db, NOW + 3_600_000, () => {});

    expect(again.disabled).toHaveLength(1);
    expect(schedule(scheduleId)).toMatchObject({ enabled: 0, next_fire: null });
    expect(runsFor(taskId)).toHaveLength(2);
    expect(auditRows()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('what the sweep must not touch', () => {
  it('leaves a safe recurring task completely alone', () => {
    const { taskId, scheduleId } = seed({ rrule: SAFE });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.checked).toBe(1);
    expect(result.disabled).toEqual([]);
    expect(schedule(scheduleId)).toMatchObject({ enabled: 1, next_fire: NOW });
    expect(runsFor(taskId)).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it('leaves cron and once schedules alone — neither goes near rrule', () => {
    const cron = seed({ kind: 'cron', rrule: null, cron: '0 3 * * *' });
    const once = seed({ kind: 'once', rrule: null, runAt: NOW + 3_600_000, nextFire: NOW + 3_600_000 });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.checked).toBe(0);
    expect(result.disabled).toEqual([]);
    expect(schedule(cron.scheduleId).enabled).toBe(1);
    expect(schedule(once.scheduleId).enabled).toBe(1);
  });

  it('leaves an already-disabled schedule alone — nothing can fire it', () => {
    const { taskId, scheduleId } = seed({ scheduleEnabled: false });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.checked).toBe(0);
    expect(schedule(scheduleId).enabled).toBe(0);
    expect(runsFor(taskId)).toEqual([]);
  });

  it('leaves a soft-deleted task alone — there is no screen to show an inbox item on', () => {
    const { taskId, scheduleId } = seed({ deleted: true });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.checked).toBe(0);
    expect(schedule(scheduleId).enabled).toBe(1);
    expect(runsFor(taskId)).toEqual([]);
  });

  it('DOES repair a paused task, because re-enabling a task never re-validates its rule', () => {
    // `tasks.enabled` is absent from the sweep's predicate on purpose, though
    // the tick requires it: `PATCH /tasks/:id {enabled:true}` flips it without
    // going near `validateAndMaterialize`, so leaving the row armed would only
    // move the hang behind a toggle.
    const { taskId, scheduleId } = seed({ taskEnabled: false });

    const result = sweepHazardousSchedules(db, NOW, () => {});

    expect(result.disabled).toHaveLength(1);
    expect(schedule(scheduleId)).toMatchObject({ enabled: 0, next_fire: null });
    expect(runsFor(taskId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('the sweep cannot be the thing that breaks the boot', () => {
  it('one unwritable row does not cost the others their repair', () => {
    // Corrupt `context_json` makes `buildJobSpec` throw while it builds the
    // inbox item's jobspec — a real way for one row to fail mid-repair.
    const broken = seed({ name: 'corrupt context', contextJson: '{not json' });
    const healthy = seed({ name: 'repairable' });

    const lines: string[] = [];
    const result = sweepHazardousSchedules(db, NOW, (m) => lines.push(m));

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.disabled.map((d) => d.taskName)).toEqual(['repairable']);
    expect(schedule(healthy.scheduleId)).toMatchObject({ enabled: 0, next_fire: null });
    // Left exactly as found. It is still dangerous, and the log says so
    // rather than pretending the repair succeeded.
    expect(schedule(broken.scheduleId).enabled).toBe(1);
    expect(runsFor(broken.taskId)).toEqual([]);
    expect(lines.some((l) => l.includes('could not repair') && l.includes('can still hang the tick'))).toBe(true);
  });

  it('says nothing at all on a healthy install', () => {
    seed({ rrule: SAFE });
    const lines: string[] = [];
    sweepHazardousSchedules(db, NOW, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it('answers on an empty database', () => {
    expect(sweepHazardousSchedules(db, NOW, () => {})).toEqual({ checked: 0, disabled: [], failed: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('where it runs in the boot sequence', () => {
  const src = (): string => readFileSync(MAIN_SRC, 'utf8');

  it('is called after the migrations and before the scheduler’s first tick', () => {
    const s = src();
    const migrate = s.indexOf('createMigrator(db, migrations, file).migrate();');
    const sweep = s.indexOf('sweepHazardousSchedules(db);');
    const buildServer = s.indexOf('await buildServer({');
    const recovery = s.indexOf('runManager.recoverySweep()');
    const listen = s.indexOf('await app.listen(');
    const firstTick = s.indexOf('scheduler.start(');

    for (const [name, at] of Object.entries({ migrate, sweep, buildServer, recovery, listen, firstTick })) {
      expect(at, `${name} not found in main.ts`).toBeGreaterThan(-1);
    }
    // The schema has to be current before the query runs...
    expect(sweep).toBeGreaterThan(migrate);
    // ...and nothing may read a stored rule first. `scheduler.start` fires its
    // first tick synchronously (scheduler.ts:76), and the calendar aggregate
    // becomes reachable the moment the server listens.
    expect(sweep).toBeLessThan(buildServer);
    expect(sweep).toBeLessThan(recovery);
    expect(sweep).toBeLessThan(listen);
    expect(sweep).toBeLessThan(firstTick);
  });

  it('cannot take the boot down: the call site catches and continues', () => {
    const s = src();
    const call = s.indexOf('sweepHazardousSchedules(db);');
    const window = s.slice(call - 200, call + 300);
    expect(window).toContain('try {');
    expect(window).toContain('catch (err)');
    expect(window).toContain('Boot continues.');
  });
});
