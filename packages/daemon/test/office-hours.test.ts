/**
 * F3 office-hours (plan/AGENT-WORKFORCE-SPEC.md §4 F3).
 *
 * Three things are defended here:
 *   1. window math in the window's own IANA zone, across both DST transitions;
 *   2. every refusal path of `shiftForApproval` — the feature fails OPEN, so a
 *      refusal means "fire on time", and a bug that turned one into a throw or
 *      a shift would cost the user a run;
 *   3. the ledger state the scheduler wiring snippet leaves behind is one the
 *      UNMODIFIED claim transaction still fires. That last one is why the
 *      snippet bumps `next_fire` instead of pre-claiming the resume instant.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { newId, type OfficeHourCreate, type OfficeHourWindow } from '@clockwork/shared';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import {
  OfficeHours,
  inOfficeHours,
  isKnownZone,
  nextOfficeHourStart,
  shiftForApproval,
} from '../src/office-hours.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const NY = 'America/New_York';
const BERLIN = 'Europe/Berlin';
const MON = 1;
const SUN = 0;

/** Local wall time in a named zone → epoch ms. */
const at = (iso: string, zone = NY): number => DateTime.fromISO(iso, { zone }).toMillis();

/** A window literal for the pure functions — no DB needed. */
const win = (over: Partial<OfficeHourWindow> = {}): OfficeHourWindow => ({
  id: 'w1',
  label: null,
  dow: MON,
  startMin: 9 * 60,
  endMin: 17 * 60,
  tz: NY,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

let db: DB;
let dir: string;
let oh: OfficeHours;

const NOW = at('2026-03-01T00:00');

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-office-'));
  const opened = openDatabase(dir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  oh = new OfficeHours(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedProfile(mayRequireApproval: boolean): string {
  const id = newId();
  db.prepare(
    `INSERT INTO profiles (id, slug, name, may_require_approval, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `p-${id}`, 'Approver', mayRequireApproval ? 1 : 0, NOW, NOW);
  return id;
}

function seedTask(profileId: string | null): string {
  const id = newId();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'Weekly report', 'do things', profileId, NOW, NOW);
  return id;
}

function makeWindow(over: Partial<OfficeHourCreate> = {}): OfficeHourWindow {
  return oh.create({ dow: MON, startMin: 9 * 60, endMin: 17 * 60, tz: NY, enabled: true, ...over }, NOW);
}

// ---------------------------------------------------------------------------

describe('office-hours window math', () => {
  it('treats the start minute as inside the window and the end minute as outside', () => {
    const w = [win()];
    expect(inOfficeHours(at('2026-03-09T09:00'), w)).toBe(true);
    expect(inOfficeHours(at('2026-03-09T16:59'), w)).toBe(true);
    expect(inOfficeHours(at('2026-03-09T08:59'), w)).toBe(false);
    expect(inOfficeHours(at('2026-03-09T17:00'), w)).toBe(false);
  });

  it('evaluates the window in its own zone, not UTC', () => {
    const w = [win()];
    // 09:00 UTC is 04:00 in New York — outside a 09:00–17:00 New York window.
    expect(inOfficeHours(at('2026-03-09T09:00', 'utc'), w)).toBe(false);
    // 13:00 UTC is 09:00 EDT — inside.
    expect(inOfficeHours(at('2026-03-09T13:00', 'utc'), w)).toBe(true);
  });

  it('ignores a disabled window', () => {
    expect(inOfficeHours(at('2026-03-09T10:00'), [win({ enabled: false })])).toBe(false);
    expect(nextOfficeHourStart(at('2026-03-08T10:00'), [win({ enabled: false })])).toBeNull();
  });

  it('ignores a window whose end is not after its start', () => {
    // OfficeHourCreate refuses this at the door; a hand-edited row can still
    // hold it, and a window that never closes must never defer anything.
    const degenerate = [win({ startMin: 600, endMin: 600 }), win({ id: 'w2', startMin: 600, endMin: 540 })];
    expect(inOfficeHours(at('2026-03-09T10:00'), degenerate)).toBe(false);
    expect(nextOfficeHourStart(at('2026-03-08T10:00'), degenerate)).toBeNull();
  });

  it('ignores a window in a zone luxon cannot resolve', () => {
    const bogus = [win({ tz: 'Mars/Olympus_Mons' })];
    expect(isKnownZone('Mars/Olympus_Mons')).toBe(false);
    expect(isKnownZone('')).toBe(false);
    expect(isKnownZone(NY)).toBe(true);
    expect(inOfficeHours(at('2026-03-09T10:00'), bogus)).toBe(false);
    expect(nextOfficeHourStart(at('2026-03-08T10:00'), bogus)).toBeNull();
  });

  it('crosses a weekend to the next open window', () => {
    const week = [1, 2, 3, 4, 5].map((dow) => win({ id: `w${dow}`, dow }));
    // Saturday morning → Monday 09:00 New York.
    expect(nextOfficeHourStart(at('2026-03-14T10:00'), week)).toBe(at('2026-03-16T09:00'));
  });

  it('skips today once the window has already closed', () => {
    // Monday 18:00 is past the 17:00 close → next Monday, not today.
    expect(nextOfficeHourStart(at('2026-03-09T18:00'), [win()])).toBe(at('2026-03-16T09:00'));
  });

  it('holds the local wall-clock hour across both DST transitions', () => {
    const sunday = [win({ dow: SUN })];
    // 2026-03-08: US clocks spring forward at 02:00 local, i.e. BETWEEN local
    // midnight and the 09:00 window start. Adding 540 minutes to the start of
    // that day lands at 10:00 EDT; the window opens at 09:00 EDT = 13:00 UTC.
    expect(nextOfficeHourStart(at('2026-03-07T20:00'), sunday)).toBe(at('2026-03-08T13:00', 'utc'));
    // 2026-11-01: clocks fall back at 02:00 local. 09:00 EST = 14:00 UTC.
    expect(nextOfficeHourStart(at('2026-10-31T20:00'), sunday)).toBe(at('2026-11-01T14:00', 'utc'));
  });

  it('picks the earliest start across windows in different zones', () => {
    const windows = [win({ id: 'ny' }), win({ id: 'berlin', tz: BERLIN })];
    // Monday 09:00 CET (08:00 UTC) opens before Monday 09:00 EDT (13:00 UTC).
    expect(nextOfficeHourStart(at('2026-03-08T22:00'), windows)).toBe(at('2026-03-09T09:00', BERLIN));
  });

  it('returns null rather than searching forever when no window can ever open', () => {
    const started = Date.now();
    expect(nextOfficeHourStart(at('2026-03-08T22:00'), [])).toBeNull();
    expect(nextOfficeHourStart(at('2026-03-08T22:00'), [win({ enabled: false }), win({ tz: 'Nowhere/Nothing' })])).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('OfficeHours store', () => {
  it('round-trips a created window through list()', () => {
    const created = makeWindow({ label: 'Mornings', startMin: 8 * 60 + 30, endMin: 11 * 60 });
    expect(created.label).toBe('Mornings');
    expect(created.startMin).toBe(510);
    expect(created.enabled).toBe(true);
    // epoch MILLISECONDS, per the migration's column convention
    expect(created.createdAt).toBe(NOW);
    expect(created.updatedAt).toBe(NOW);
    expect(oh.list()).toEqual([created]);
  });

  it('lists a disabled window too, so the UI can turn it back on', () => {
    const off = makeWindow({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(oh.list().map((w) => w.id)).toEqual([off.id]);
  });

  it('remove() reports false for an unknown id and true for a real one', () => {
    const w = makeWindow();
    expect(oh.remove('no-such-window')).toBe(false);
    expect(oh.list()).toHaveLength(1);
    expect(oh.remove(w.id)).toBe(true);
    expect(oh.list()).toEqual([]);
    expect(oh.remove(w.id)).toBe(false);
  });

  it('is off until it is switched on', () => {
    // 0008 seeds office_hours_enabled = 0: enabling the feature must be a
    // deliberate act, never a side effect of creating a window.
    expect(oh.enabled()).toBe(false);
    makeWindow();
    expect(oh.enabled()).toBe(false);
    oh.setEnabled(true);
    expect(oh.enabled()).toBe(true);
    oh.setEnabled(false);
    expect(oh.enabled()).toBe(false);
  });
});

describe('shiftForApproval refuses to move a run', () => {
  const FIRE = at('2026-03-08T22:00'); // Sunday night, outside every Monday window

  it('while the master switch is off', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow();
    expect(oh.enabled()).toBe(false);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('when the profile is not flagged may_require_approval', () => {
    const taskId = seedTask(seedProfile(false));
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('when the task has no profile at all', () => {
    const taskId = seedTask(null);
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('for a task id that does not exist', () => {
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, 'ghost-task', FIRE)).toBeNull();
  });

  it('when no windows have been declared', () => {
    const taskId = seedTask(seedProfile(true));
    oh.setEnabled(true);
    expect(oh.list()).toEqual([]);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('when every declared window is disabled', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow({ enabled: false });
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('when the only window names a zone luxon cannot resolve', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow({ tz: 'Mars/Olympus_Mons' });
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });

  it('when the run already fires inside a window', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, at('2026-03-09T09:00'))).toBeNull();
    expect(shiftForApproval(db, taskId, at('2026-03-09T16:59'))).toBeNull();
  });

  it('and fails open — a missing office_hours table returns null, it does not throw', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, FIRE)).not.toBeNull(); // it would have shifted
    db.exec('DROP TABLE office_hours');
    expect(() => shiftForApproval(db, taskId, FIRE)).not.toThrow();
    expect(shiftForApproval(db, taskId, FIRE)).toBeNull();
  });
});

describe('shiftForApproval moves an approval-bearing run', () => {
  it('to the start of the next window', () => {
    const taskId = seedTask(seedProfile(true));
    makeWindow();
    oh.setEnabled(true);
    expect(shiftForApproval(db, taskId, at('2026-03-08T22:00'))).toBe(at('2026-03-09T09:00'));
  });

  it('exactly once — the shifted instant is already inside the window', () => {
    // The anti-loop invariant. The scheduler re-enters at the shifted instant;
    // if that instant shifted again the task would walk forward forever and
    // never run.
    const taskId = seedTask(seedProfile(true));
    makeWindow();
    oh.setEnabled(true);
    const shifted = shiftForApproval(db, taskId, at('2026-03-08T22:00'));
    expect(shifted).not.toBeNull();
    expect(shiftForApproval(db, taskId, shifted as number)).toBeNull();
  });

  it('and leaves an unflagged task on the same clock untouched', () => {
    const flagged = seedTask(seedProfile(true));
    const plain = seedTask(seedProfile(false));
    makeWindow();
    oh.setEnabled(true);
    const fire = at('2026-03-08T22:00');
    expect(shiftForApproval(db, flagged, fire)).toBe(at('2026-03-09T09:00'));
    expect(shiftForApproval(db, plain, fire)).toBeNull();
  });
});

describe('the deferred occurrence the scheduler must still fire', () => {
  /**
   * The wiring snippet marks the claimed occurrence 'deferred' and repoints
   * `next_fire` at the shifted instant WITHOUT pre-claiming a ledger row
   * there. These tests reproduce that exact post-deferral state and then run
   * the real, unmodified Scheduler at the shifted instant: the claim
   * transaction must win its INSERT OR IGNORE and enqueue the run.
   *
   * Pre-claiming the resume instant 'pending' — the ADR-030 quiet-hours
   * spelling — makes that claim a no-op, and the deferred work never fires.
   */
  const fireAt = at('2026-03-08T22:00');
  const shifted = at('2026-03-09T09:00');

  async function runScheduler(kind: 'cron' | 'once'): Promise<{ enqueued: string[]; scheduleId: string; taskId: string }> {
    const taskId = seedTask(seedProfile(true));
    // Office hours stay ON for this tick: once the wiring snippet is applied,
    // the tick at `shifted` calls shiftForApproval again, and this is what
    // proves it fires instead of walking the task forward a second time.
    makeWindow();
    oh.setEnabled(true);
    const scheduleId = newId();
    db.prepare(
      `INSERT INTO schedules (id, task_id, kind, cron, run_at, tz, next_fire, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      scheduleId,
      taskId,
      kind,
      kind === 'cron' ? '0 22 * * 0' : null,
      kind === 'once' ? fireAt : null,
      NY,
      shifted, // what the snippet leaves behind
    );
    // the occurrence the snippet deferred; deliberately NO row at `shifted`
    db.prepare(
      `INSERT INTO schedule_occurrences (schedule_id, occurrence_at, disposition, claimed_at) VALUES (?, ?, 'deferred', ?)`,
    ).run(scheduleId, fireAt, fireAt);

    const enqueued: string[] = [];
    const scheduler = new Scheduler({
      db,
      clock: new FakeClock(shifted),
      enqueueRun: (spec) => enqueued.push(spec.runId),
      notify: () => {},
    });
    await scheduler.tick();
    scheduler.stop();
    return { enqueued, scheduleId, taskId };
  }

  it('fires at the shifted instant for a recurring schedule and advances next_fire', async () => {
    const { enqueued, scheduleId } = await runScheduler('cron');
    expect(enqueued).toHaveLength(1);
    const occ = db
      .prepare('SELECT disposition, run_id FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, shifted) as { disposition: string; run_id: string | null };
    expect(occ.disposition).toBe('fired');
    expect(occ.run_id).toBe(enqueued[0]);
    const deferred = db
      .prepare('SELECT disposition FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, fireAt) as { disposition: string };
    expect(deferred.disposition).toBe('deferred'); // the original claim is untouched
    const sched = db.prepare('SELECT next_fire FROM schedules WHERE id=?').get(scheduleId) as { next_fire: number | null };
    expect(sched.next_fire).toBe(at('2026-03-15T22:00')); // the next Sunday 22:00
  });

  it('fires at the shifted instant for a one-shot schedule and then retires it', async () => {
    const { enqueued, scheduleId } = await runScheduler('once');
    expect(enqueued).toHaveLength(1);
    const occ = db
      .prepare('SELECT disposition FROM schedule_occurrences WHERE schedule_id=? AND occurrence_at=?')
      .get(scheduleId, shifted) as { disposition: string };
    expect(occ.disposition).toBe('fired');
    const sched = db.prepare('SELECT next_fire FROM schedules WHERE id=?').get(scheduleId) as { next_fire: number | null };
    expect(sched.next_fire).toBeNull();
  });
});
