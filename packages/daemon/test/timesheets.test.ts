/**
 * F10 timesheets (plan/AGENT-WORKFORCE-SPEC.md, §F10).
 *
 * Defends: the run_outcomes.profile_id grouping key with a jobspec_json
 * fallback for runs that predate F6 (zero-wiring history), the
 * COALESCE(ended_at, scheduled_for) window with ended_at taking priority and
 * the upper bound exclusive / lower bound inclusive, hoursWorked counting
 * only rows with both timestamps while a never-started run still contributes
 * its cost, effectiveHourlyRateUsd being null (never Infinity) at zero hours,
 * outcomesAccepted counting both accepted and accepted_with_note while
 * outcomesRejected counts only rejected, rows sorted by dollarsSpent
 * descending, the profileId filter, identity resolution preferring a live
 * profiles join but falling back to the jobspec snapshot for a deleted
 * profile, and humanHourlyRate/setHumanHourlyRate round-tripping through
 * workforce_prefs including back to null.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { timesheet, humanHourlyRate, setHumanHourlyRate } from '../src/timesheets.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  return db;
}

function insertTask(db: DB, id: string, now: number): void {
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    `task-${id}`,
    'do the thing',
    now,
    now,
  );
}

function insertProfile(db: DB, id: string, slug: string, name: string, now: number): void {
  db.prepare(`INSERT INTO profiles (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    slug,
    name,
    now,
    now,
  );
}

interface RunOpts {
  id: string;
  taskId: string;
  profileId?: string | null;
  profileSlug?: string;
  profileName?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  scheduledFor?: number | null;
  costUsd?: number | null;
}

function insertRun(db: DB, opts: RunOpts): void {
  const jobspec = JSON.stringify({
    taskId: opts.taskId,
    profile: opts.profileId
      ? { id: opts.profileId, slug: opts.profileSlug ?? `${opts.profileId}-slug`, name: opts.profileName ?? opts.profileId }
      : null,
  });
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, ended_at, scheduled_for, cost_usd)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.taskId,
    jobspec,
    opts.startedAt ?? opts.scheduledFor ?? 0,
    opts.startedAt ?? null,
    opts.endedAt ?? null,
    opts.scheduledFor ?? null,
    opts.costUsd ?? null,
  );
}

function insertOutcome(db: DB, runId: string, taskId: string, profileId: string | null, decision: string, now: number): void {
  db.prepare(
    `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, actor, decided_at) VALUES (?, ?, ?, ?, 'local', ?)`,
  ).run(runId, taskId, profileId, decision, now);
}

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const FROM = T0;
const TO = T0 + 7 * 24 * HOUR;

describe('timesheet — grouping key', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('prefers run_outcomes.profile_id when a decision exists', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, costUsd: 10 });
    insertOutcome(db, 'r1', 't1', 'p1', 'accepted', T0 + 3 * HOUR);
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.profileId).toBe('p1');
  });

  it('falls back to jobspec_json profile.id when no run_outcomes row exists — historical runs count with zero wiring', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p2', startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, costUsd: 20 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.profileId).toBe('p2');
    expect(sheet.rows[0]!.dollarsSpent).toBe(20);
  });

  it('groups a profile-less run under profileId: null, profileName: "Unassigned"', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: null, startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, costUsd: 3 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.profileId).toBeNull();
    expect(sheet.rows[0]!.profileSlug).toBeNull();
    expect(sheet.rows[0]!.profileName).toBe('Unassigned');
  });
});

describe('timesheet — window', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('excludes a run whose ended_at falls before fromMs even when scheduled_for is inside the window', () => {
    // COALESCE(ended_at, scheduled_for) must prefer ended_at when it is non-null.
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', endedAt: FROM - 50, scheduledFor: FROM + HOUR, costUsd: 999 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(0);
  });

  it('the lower bound is inclusive and the upper bound is exclusive', () => {
    insertRun(db, { id: 'r-at-from', taskId: 't1', profileId: 'p1', endedAt: FROM, costUsd: 1 });
    insertRun(db, { id: 'r-at-to', taskId: 't1', profileId: 'p1', endedAt: TO, costUsd: 2 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.dollarsSpent).toBe(1);
  });

  it('a run entirely outside the window (via scheduled_for, no ended_at) contributes nothing', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', scheduledFor: FROM - HOUR, costUsd: 50 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(0);
  });
});

describe('timesheet — hoursWorked and effectiveHourlyRateUsd', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('sums MAX(0, ended_at - started_at) only across rows where both are non-null', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0 + HOUR, endedAt: T0 + 3 * HOUR, costUsd: 10 });
    insertRun(db, { id: 'r2', taskId: 't1', profileId: 'p1', startedAt: T0 + 4 * HOUR, endedAt: T0 + 5 * HOUR, costUsd: 5 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.hoursWorked).toBe(3);
    expect(sheet.rows[0]!.dollarsSpent).toBe(15);
    expect(sheet.rows[0]!.effectiveHourlyRateUsd).toBe(5);
  });

  it('a run that never started contributes 0 hours but still contributes its cost', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p3', scheduledFor: T0 + 2 * HOUR, costUsd: 2 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.hoursWorked).toBe(0);
    expect(sheet.rows[0]!.dollarsSpent).toBe(2);
  });

  it('clamps a negative duration (ended_at before started_at) to 0 hours rather than subtracting — cost still counts', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p5', startedAt: T0 + 3 * HOUR, endedAt: T0 + HOUR, costUsd: 4 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.hoursWorked).toBe(0);
    expect(sheet.rows[0]!.dollarsSpent).toBe(4);
    expect(sheet.rows[0]!.effectiveHourlyRateUsd).toBeNull();
  });

  it('effectiveHourlyRateUsd is null — never Infinity, never 0 — when hoursWorked is 0', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p3', scheduledFor: T0 + 2 * HOUR, costUsd: 2 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows[0]!.effectiveHourlyRateUsd).toBeNull();
  });

  it('a run with no cost_usd recorded (NULL) contributes 0 dollars, not NaN', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, costUsd: null });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows[0]!.dollarsSpent).toBe(0);
    expect(sheet.rows[0]!.effectiveHourlyRateUsd).toBe(0);
  });
});

describe('timesheet — outcomes', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('counts accepted and accepted_with_note as outcomesAccepted, rejected as outcomesRejected, and undecided runs as neither', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 1 });
    insertOutcome(db, 'r1', 't1', 'p1', 'accepted', T0 + 2 * HOUR);
    insertRun(db, { id: 'r2', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 1 });
    insertOutcome(db, 'r2', 't1', 'p1', 'accepted_with_note', T0 + 2 * HOUR);
    insertRun(db, { id: 'r3', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 1 });
    insertOutcome(db, 'r3', 't1', 'p1', 'rejected', T0 + 2 * HOUR);
    insertRun(db, { id: 'r4', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 1 });
    // r4 never decided

    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.runs).toBe(4);
    expect(sheet.rows[0]!.outcomesAccepted).toBe(2);
    expect(sheet.rows[0]!.outcomesRejected).toBe(1);
  });
});

describe('timesheet — sort order and profileId filter', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('sorts rows by dollarsSpent descending', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p-low', startedAt: T0, endedAt: T0 + HOUR, costUsd: 2 });
    insertRun(db, { id: 'r2', taskId: 't1', profileId: 'p-high', startedAt: T0, endedAt: T0 + HOUR, costUsd: 20 });
    insertRun(db, { id: 'r3', taskId: 't1', profileId: 'p-mid', startedAt: T0, endedAt: T0 + HOUR, costUsd: 10 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows.map((r) => r.profileId)).toEqual(['p-high', 'p-mid', 'p-low']);
  });

  it('the profileId option restricts the result to a single agent', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 2 });
    insertRun(db, { id: 'r2', taskId: 't1', profileId: 'p2', startedAt: T0, endedAt: T0 + HOUR, costUsd: 20 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO, profileId: 'p1' });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.profileId).toBe('p1');
  });

  it('an unknown profileId filter returns an empty rows array, not an error', () => {
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 2 });
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO, profileId: 'does-not-exist' });
    expect(sheet.rows).toEqual([]);
  });
});

describe('timesheet — identity resolution', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
    insertTask(db, 't1', T0);
  });

  it('prefers the live profiles row (a rename after the run shows the current name)', () => {
    insertProfile(db, 'p1', 'p-one', 'P One', T0);
    insertRun(db, {
      id: 'r1',
      taskId: 't1',
      profileId: 'p1',
      profileSlug: 'p-one',
      profileName: 'P One',
      startedAt: T0,
      endedAt: T0 + HOUR,
      costUsd: 1,
    });
    db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run('P One Renamed', 'p1');

    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows[0]!.profileName).toBe('P One Renamed');
    expect(sheet.rows[0]!.profileSlug).toBe('p-one');
  });

  it('falls back to the jobspec_json snapshot when the profile has since been deleted', () => {
    insertProfile(db, 'p4', 'bot-four', 'Bot Four', T0);
    insertRun(db, {
      id: 'r1',
      taskId: 't1',
      profileId: 'p4',
      profileSlug: 'bot-four',
      profileName: 'Bot Four',
      startedAt: T0,
      endedAt: T0 + HOUR,
      costUsd: 1,
    });
    db.prepare('DELETE FROM profiles WHERE id = ?').run('p4');

    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]!.profileId).toBe('p4');
    expect(sheet.rows[0]!.profileName).toBe('Bot Four');
    expect(sheet.rows[0]!.profileSlug).toBe('bot-four');
  });
});

describe('timesheet — bad range (refusal path this module is responsible for)', () => {
  it('a toMs <= fromMs range yields an empty rows array rather than throwing — the route owns 422, not this module', () => {
    const db = freshDb();
    insertTask(db, 't1', T0);
    insertRun(db, { id: 'r1', taskId: 't1', profileId: 'p1', startedAt: T0, endedAt: T0 + HOUR, costUsd: 5 });
    const sheet = timesheet(db, { fromMs: TO, toMs: FROM });
    expect(sheet.rows).toEqual([]);
    expect(sheet.fromMs).toBe(TO);
    expect(sheet.toMs).toBe(FROM);
  });
});

describe('timesheet — humanHourlyRateUsd', () => {
  it('is included on every Timesheet and reflects the current workforce_prefs value', () => {
    const db = freshDb();
    setHumanHourlyRate(db, 75);
    const sheet = timesheet(db, { fromMs: FROM, toMs: TO });
    expect(sheet.humanHourlyRateUsd).toBe(75);
  });
});

describe('humanHourlyRate / setHumanHourlyRate', () => {
  it('defaults to null (no comparison rate set)', () => {
    const db = freshDb();
    expect(humanHourlyRate(db)).toBeNull();
  });

  it('round-trips a rate through workforce_prefs', () => {
    const db = freshDb();
    setHumanHourlyRate(db, 42.5);
    expect(humanHourlyRate(db)).toBe(42.5);
  });

  it('can be cleared back to null', () => {
    const db = freshDb();
    setHumanHourlyRate(db, 42.5);
    setHumanHourlyRate(db, null);
    expect(humanHourlyRate(db)).toBeNull();
  });
});
