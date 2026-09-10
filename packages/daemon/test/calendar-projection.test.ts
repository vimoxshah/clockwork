/**
 * T4-4 — the calendar shows the future, not just the next one.
 *
 * WHAT WAS WRONG. `GET /calendar` already walked each enabled schedule forward
 * from "now", but it asked for a flat 62 occurrences per schedule and reported
 * nothing about that number. An hourly job over a 42-day month grid has 1,008
 * occurrences and got 62 — it appeared for two and a half days and then vanished
 * for the rest of the month. Worse, `bookings.truncated` was derived as
 * `total > returned` from a total that only counted what came back, so the cut
 * answer reported itself complete. That is the exact failure the S-64 bound was
 * built to prevent, reintroduced one collection over.
 *
 * WHAT THIS FILE PINS
 *   1. RHYTHM. A weekly task appears on EVERY week of a visible month, and the
 *      ghosts are distinguishable from the one occurrence the scheduler has
 *      actually booked and from a run that already happened.
 *   2. A BOUND THAT REPORTS ITSELF. The projection is capped per schedule, the
 *      cap widens with the view (week < month < year), `?limit=` may only lower
 *      it, and `limits.projection.truncated` says when it bit — in BOTH the
 *      detail and the per-day modes.
 *   3. FAIRNESS. The budget is shared, so one per-minute job cannot spend it all
 *      and leave the weekly job invisible.
 *   4. REFUSAL, NOT EXPANSION. A rule shape `guardSchedule` calls unsafe is
 *      skipped and counted, never handed to rrule.
 *
 * A WARNING ABOUT (4), STATED RATHER THAN HIDDEN. `FREQ=HOURLY;INTERVAL=2;
 * BYHOUR=3` does not throw and does not run long — it is a synchronous infinite
 * loop inside rrule 2.8.1's skip loop. No `testTimeout` can interrupt one. So if
 * the guard is ever removed from the calendar route, the test below does not go
 * red: it WEDGES the suite. That is a property of the hazard, not of the test,
 * and it is the reason the guard is checked directly (pure arithmetic, cannot
 * loop) immediately before the route case that depends on it.
 *
 * NOT MEASURED HERE. Latency is a property of the machine as much as the code;
 * it lives in `calendar-aggregate-bench.test.ts` behind `helpers/bench-gate.ts`.
 * This file asserts counts, flags and ordering only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import {
  buildServer,
  CALENDAR_PROJECTION_PER_DAY,
  CALENDAR_ROW_LIMIT,
  MAX_RRULE_COUNT,
} from '../src/api.js';
import { guardSchedule } from '../src/schedule-guard.js';
import { occurrencesBetweenBounded } from '../src/recurrence.js';
import { SafetyJournal } from '@clockwork/runner';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const DAY_MS = 86_400_000;

/**
 * The schedule's zone is the reader's zone, deliberately. Every assertion below
 * is about which LOCAL DAY a ghost lands on, and the grid is built from local
 * midnights — expanding in UTC while asserting in local time would make this
 * file pass or fail on where the machine is.
 */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let db: DB;
let dataDir: string;
let app: FastifyInstance;
let token: string;

interface CollectionLimit {
  returned: number;
  total: number;
  truncated: boolean;
}
interface ProjectionLimit {
  perSchedule: number;
  truncated: boolean;
  refused: number;
}
interface Limits {
  rowLimit: number;
  truncated: boolean;
  projection: ProjectionLimit;
  runs?: CollectionLimit;
  bookings: CollectionLimit;
  humans?: CollectionLimit;
  days?: CollectionLimit;
}
interface Booking {
  taskId: string;
  name: string;
  at: number;
  kind: 'booking';
  projected: boolean;
}
interface DetailBody {
  from: number;
  to: number;
  runs: Array<Record<string, unknown>>;
  bookings: Booking[];
  limits: Limits;
}
interface AggregateBody {
  from: number;
  to: number;
  group: 'day';
  days: Array<{ day: string; runs: number; bookings: number }>;
  limits: Limits;
}

function auth(url: string): { method: 'GET'; url: string; headers: Record<string, string> } {
  return { method: 'GET', url, headers: { authorization: `Bearer ${token}` } };
}

async function detail(url: string): Promise<DetailBody> {
  const res = await app.inject(auth(url));
  expect(res.statusCode, res.payload.slice(0, 300)).toBe(200);
  return res.json() as DetailBody;
}

async function aggregate(url: string): Promise<AggregateBody> {
  const res = await app.inject(auth(url));
  expect(res.statusCode, res.payload.slice(0, 300)).toBe(200);
  return res.json() as AggregateBody;
}

/** Local midnight of the day containing `ms` — the grid's own cell key. */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Which of the six grid rows a day sits in.
 *
 * Rounded, not floored, because a 42-day grid can cross a DST transition and
 * then a "week" is 7 days ± an hour. Rounding to whole days absorbs that; a raw
 * millisecond division would put an occurrence in the previous row twice a year.
 */
function weekIndex(gridFrom: number, at: number): number {
  return Math.floor(Math.round((localMidnight(at) - gridFrom) / DAY_MS) / 7);
}

/**
 * The 42-cell window the month view asks for, `monthsAhead` months from now.
 *
 * Copied from `CalendarView.tsx`'s own `range` memo rather than invented: the
 * grid starts on the Monday on or before the 1st and is exactly 42 days wide,
 * so "every week of a visible month" means six rows.
 */
function monthGrid(monthsAhead: number): { from: number; to: number } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + monthsAhead, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  return { from, to: from + 42 * DAY_MS };
}

/** A future window that starts tomorrow, so `now` never clips its lower end. */
function futureWindow(days: number): { from: number; to: number } {
  const from = localMidnight(Date.now()) + DAY_MS;
  return { from, to: from + days * DAY_MS };
}

let taskSeq = 0;

/** A task plus one enabled schedule. Returns the task id. */
function seedTask(opts: {
  name: string;
  kind: 'rrule' | 'cron' | 'once';
  rrule?: string | null;
  cron?: string | null;
  runAt?: number | null;
  nextFire?: number | null;
}): string {
  const id = `proj-task-${String(taskSeq++).padStart(3, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, created_at, updated_at)
     VALUES (?, ?, 'p', '/tmp/proj', ?, ?)`,
  ).run(id, opts.name, now, now);
  db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    `${id}-sched`,
    id,
    opts.kind,
    opts.rrule ?? null,
    opts.cron ?? null,
    opts.runAt ?? null,
    TZ,
    opts.nextFire ?? null,
  );
  return id;
}

/** Removes every task and schedule this file seeded, so describes stay isolated. */
function clearSeed(): void {
  db.prepare(`DELETE FROM schedules WHERE task_id LIKE 'proj-task-%'`).run();
  db.prepare(`DELETE FROM runs WHERE task_id LIKE 'proj-task-%'`).run();
  db.prepare(`DELETE FROM tasks WHERE id LIKE 'proj-task-%'`).run();
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cw-cal-proj-'));
  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();

  const clock = new FakeClock(Date.now());
  const runManager = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dataDir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir, runManager, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The rhythm — the whole point of the task.
// ---------------------------------------------------------------------------
describe('a weekly job is visible on every week of the month, not once or twice', () => {
  const grid = monthGrid(2); // wholly in the future, so `now` clips nothing
  let taskId: string;

  beforeAll(() => {
    clearSeed();
    // Wednesday: every Monday-start week of a 42-day grid contains exactly one,
    // so "one per row" is six, not five-or-six depending on the month.
    taskId = seedTask({ name: 'Weekly dep triage', kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0' });
  });
  afterAll(() => clearSeed());

  it('projects one ghost into every one of the six grid weeks', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const mine = body.bookings.filter((b) => b.taskId === taskId);

    expect(mine.length, `expected one per grid week, got ${mine.length}`).toBe(6);
    expect(mine.map((b) => weekIndex(grid.from, b.at))).toEqual([0, 1, 2, 3, 4, 5]);
    // Every ghost lands on its own day, and they are a week apart in CALENDAR
    // days — asserted in days rather than milliseconds because a DST transition
    // makes one of those weeks 167 or 169 hours long.
    const days = mine.map((b) => Math.round((localMidnight(b.at) - grid.from) / DAY_MS));
    expect(new Set(days).size).toBe(6);
    expect(days.map((d, i) => (i === 0 ? 7 : d - days[i - 1]!)).slice(1)).toEqual([7, 7, 7, 7, 7]);
  });

  it('answers in calendar order, so the grid can read it straight through', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const ats = body.bookings.map((b) => b.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// 2. Three kinds of mark, and they must not be one kind.
// ---------------------------------------------------------------------------
describe('a projection is not a booking, and neither is a run', () => {
  const grid = monthGrid(0); // THIS month: half past, half future
  let taskId: string;

  beforeAll(() => {
    clearSeed();
    taskId = seedTask({ name: 'Docs drift check', kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
    // A run that already happened, inside the same window.
    const at = Date.now() - 2 * 3_600_000;
    db.prepare(
      `INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at,
                         cost_usd, turns, started_at, ended_at, scheduled_for, outcome_reason)
       VALUES ('proj-run-past', ?, ?, ?, 'completed', ?, 0.5, 3, ?, ?, ?, NULL)`,
    ).run(taskId, at, JSON.stringify({ taskName: 'Docs drift check' }), at, at, at + 60_000, at);
  });
  afterAll(() => clearSeed());

  it('marks exactly the materialized next fire as booked and the rest as projected', async () => {
    // `next_fire` is what the scheduler has actually committed to. Take it from
    // the projection itself so the two cannot drift apart in this fixture.
    const first = (await detail(`/calendar?from=${grid.from}&to=${grid.to}`)).bookings[0]!;
    db.prepare(`UPDATE schedules SET next_fire = ? WHERE task_id = ?`).run(first.at, taskId);

    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const booked = body.bookings.filter((b) => !b.projected);
    const ghosts = body.bookings.filter((b) => b.projected);

    expect(booked.map((b) => b.at), 'only the materialized next fire is booked').toEqual([first.at]);
    expect(ghosts.length, 'the rest of the month is projection, and there is some of it').toBeGreaterThan(1);
    expect(ghosts.every((g) => g.at > first.at), 'a projection can only be AFTER the booked fire').toBe(true);
  });

  it('keeps the run that already happened in `runs`, never as a ghost', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    expect(body.runs.map((r) => r.id)).toContain('proj-run-past');
    const pastRun = body.runs.find((r) => r.id === 'proj-run-past')!;
    expect(pastRun.state).toBe('completed');
    // No booking may sit on or before the run's instant: the past is what the
    // ledger says happened, not what the rule would have liked to happen.
    expect(body.bookings.filter((b) => b.at <= (pastRun.scheduled_for as number))).toEqual([]);
  });

  it('projects forward from now, never back over the visible past', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const now = Date.now();
    expect(body.bookings.filter((b) => b.at < now - 60_000), 'a ghost before now fabricates history').toEqual([]);
    expect(body.bookings.length, 'and there is still a future to show').toBeGreaterThan(0);
  });

  it('says every ghost belongs to the task that will run it', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    expect(body.bookings.every((b) => b.taskId === taskId && b.name === 'Docs drift check')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The bound: per view, in the daemon, and reported.
// ---------------------------------------------------------------------------
describe('the projection is bounded per view, and the response says which bound', () => {
  beforeAll(() => {
    clearSeed();
    seedTask({ name: 'Hourly sweep', kind: 'rrule', rrule: 'FREQ=HOURLY;BYMINUTE=0' });
  });
  afterAll(() => clearSeed());

  it('widens the per-schedule cap with the window: week < month < year', async () => {
    // 24 per day of window — one an hour, the densest schedule that still reads
    // as a schedule — clamped by the row ceiling. One recurring schedule here,
    // so the fair share (5,000) never binds and the view is what decides.
    const cases: Array<[number, number]> = [
      [7, 7 * CALENDAR_PROJECTION_PER_DAY], // 168
      [42, 42 * CALENDAR_PROJECTION_PER_DAY], // 1008
      [365, CALENDAR_ROW_LIMIT], // 8,760 asked for, 5,000 allowed
    ];
    for (const [days, expected] of cases) {
      const w = futureWindow(days);
      const body = await detail(`/calendar?from=${w.from}&to=${w.to}`);
      expect(body.limits.projection.perSchedule, `${days}-day window`).toBe(expected);
    }
  });

  it('lets `?limit=` lower the projection bound, and never raise it', async () => {
    const w = futureWindow(42);
    const lowered = await detail(`/calendar?from=${w.from}&to=${w.to}&limit=10`);
    expect(lowered.limits.projection.perSchedule).toBe(10);

    // `?limit=` above the ceiling is clamped to it, exactly as the row bound is.
    const raised = await detail(`/calendar?from=${w.from}&to=${w.to}&limit=${CALENDAR_ROW_LIMIT * 4}`);
    expect(raised.limits.projection.perSchedule).toBe(42 * CALENDAR_PROJECTION_PER_DAY);
  });

  it('says truncated — in `projection` AND in `bookings` — when the bound bites', async () => {
    const w = futureWindow(42);
    const body = await detail(`/calendar?from=${w.from}&to=${w.to}&limit=10`);

    expect(body.bookings.length, 'the cap is the cap').toBe(10);
    expect(body.limits.projection.truncated, 'the projection stopped early and must say so').toBe(true);
    expect(body.limits.bookings.truncated, 'a caller reading `bookings` alone must still see it').toBe(true);
    expect(body.limits.truncated, 'and the response-wide flag must be set').toBe(true);
  });

  it('says NOT truncated when the whole window fits, so the flag means something', async () => {
    clearSeed();
    seedTask({ name: 'Daily digest', kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
    try {
      const w = futureWindow(42);
      const body = await detail(`/calendar?from=${w.from}&to=${w.to}`);
      expect(body.bookings.length).toBe(42);
      expect(body.limits.projection.perSchedule).toBe(42 * CALENDAR_PROJECTION_PER_DAY);
      expect(body.limits.projection.truncated).toBe(false);
      expect(body.limits.bookings.truncated).toBe(false);
      expect(body.limits.truncated).toBe(false);
    } finally {
      clearSeed();
      seedTask({ name: 'Hourly sweep', kind: 'rrule', rrule: 'FREQ=HOURLY;BYMINUTE=0' });
    }
  });

  it('puts an hourly job on every day of the month grid, not on the first two', async () => {
    // THE DEFECT, in its general form. The old call site asked for 62
    // occurrences per schedule whatever the window was, and 62 hours is two and
    // a half days: an hourly job was drawn at the start of the month and was
    // simply absent from the other thirty-nine.
    const grid = monthGrid(2);
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const covered = new Set(body.bookings.map((b) => localMidnight(b.at)));
    const g = new Date(grid.from);
    // The first forty of the forty-two, so the assertion is nowhere near either
    // edge of the window and a DST-shortened last day cannot decide it.
    for (let d = 0; d < 40; d++) {
      const day = new Date(g.getFullYear(), g.getMonth(), g.getDate() + d).getTime();
      expect(covered.has(day), `no ghost anywhere on grid day ${d}`).toBe(true);
    }
  });

  it('records what the flat 62 actually covered, so the fix is not taken on trust', () => {
    const grid = monthGrid(2);
    const hourly = { kind: 'rrule' as const, rrule: 'FREQ=HOURLY;BYMINUTE=0', tz: TZ };
    const old = occurrencesBetweenBounded(hourly, grid.from, grid.to, 62);
    expect(new Set(old.occurrences.map(localMidnight)).size, '62 hours is under three days').toBeLessThanOrEqual(4);
    // And the old call site had no way to learn that — this flag is new.
    expect(old.truncated).toBe(true);
  });

  it('reports the same bound through the per-day fold, which has no rows to show it', async () => {
    const w = futureWindow(42);
    const agg = await aggregate(`/calendar?from=${w.from}&to=${w.to}&group=day&limit=10`);
    expect(agg.limits.projection.perSchedule).toBe(10);
    expect(agg.limits.projection.truncated).toBe(true);
    expect(agg.limits.bookings.truncated).toBe(true);
    expect(agg.limits.truncated).toBe(true);
    // The counts that DID arrive are still counts of real occurrences.
    expect(agg.days.reduce((a, d) => a + d.bookings, 0)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Fairness — a bound that starves the other jobs has not solved anything.
// ---------------------------------------------------------------------------
describe('one dense job cannot spend the whole budget', () => {
  const grid = monthGrid(2);
  let weeklyId: string;
  let denseId: string;

  beforeAll(() => {
    clearSeed();
    weeklyId = seedTask({ name: 'Weekly dep triage', kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0' });
    denseId = seedTask({ name: 'Per-minute canary', kind: 'rrule', rrule: 'FREQ=MINUTELY' });
  });
  afterAll(() => clearSeed());

  it('still shows the weekly job on all six weeks next to a per-minute one', async () => {
    const body = await detail(`/calendar?from=${grid.from}&to=${grid.to}`);
    const weekly = body.bookings.filter((b) => b.taskId === weeklyId);
    const dense = body.bookings.filter((b) => b.taskId === denseId);

    expect(weekly.map((b) => weekIndex(grid.from, b.at))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(dense.length, 'the dense job is capped, not unbounded').toBe(body.limits.projection.perSchedule);
    expect(body.limits.projection.truncated).toBe(true);
  });

  it('shrinks each schedule’s share as more schedules compete for the ceiling', async () => {
    clearSeed();
    // 25 schedules share the 5,000-row ceiling: 200 each, below the 1,008 a
    // 42-day view would otherwise allow, so the fair share is what binds.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(seedTask({ name: `Daily ${i}`, kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }));
    }
    try {
      const w = futureWindow(42);
      const body = await detail(`/calendar?from=${w.from}&to=${w.to}`);
      expect(body.limits.projection.perSchedule).toBe(CALENDAR_ROW_LIMIT / 25);
      // Every one of them is still on the calendar — that is what the share buys.
      const seen = new Set(body.bookings.map((b) => b.taskId));
      expect([...ids].filter((id) => !seen.has(id)), 'a job with no ghost at all').toEqual([]);
    } finally {
      clearSeed();
      weeklyId = seedTask({ name: 'Weekly dep triage', kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0' });
      denseId = seedTask({ name: 'Per-minute canary', kind: 'rrule', rrule: 'FREQ=MINUTELY' });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Refusal — the projection must not be the path that hangs the daemon.
// ---------------------------------------------------------------------------
describe('a rule the schedule guard refuses is never expanded by this path', () => {
  /** Unreachable BY parts: an infinite loop in rrule 2.8.1, not a slow answer. */
  const HANG = 'FREQ=HOURLY;INTERVAL=2;BYHOUR=3';
  /** A sub-daily counter with a coarser BY part: refused because it cannot be proved to terminate. */
  const UNPROVABLE = 'FREQ=MINUTELY;BYHOUR=9';

  let safeId: string;

  beforeAll(() => {
    clearSeed();
    safeId = seedTask({ name: 'Release notes draft', kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' });
    // Written straight into the table, because that is the only way they get
    // there: `POST /tasks` has run `guardSchedule` since the guard landed. A row
    // predating it, or one written by an import, is exactly this shape.
    seedTask({ name: 'Legacy hazard', kind: 'rrule', rrule: HANG });
    seedTask({ name: 'Legacy unprovable', kind: 'rrule', rrule: UNPROVABLE });
  });
  afterAll(() => clearSeed());

  it('recognises both shapes as unsafe — arithmetic only, nothing expanded', () => {
    // O(BY parts) and no call into rrule, so this assertion cannot itself hang.
    // It runs FIRST on purpose: it is the reason the route case below is safe.
    expect(guardSchedule('rrule', HANG, MAX_RRULE_COUNT)).toMatchObject({ safe: false, reason: 'unreachable' });
    expect(guardSchedule('rrule', UNPROVABLE, MAX_RRULE_COUNT)).toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('skips them, counts them, and still answers with the schedules that are safe', async () => {
    const w = futureWindow(30);
    const body = await detail(`/calendar?from=${w.from}&to=${w.to}`);

    expect(body.limits.projection.refused, 'both hazards must be refused, not expanded').toBe(2);
    expect(body.bookings.length, 'the safe daily schedule still projects').toBe(30);
    expect(body.bookings.every((b) => b.taskId === safeId), 'nothing from a refused rule may appear').toBe(true);
  });

  it('reports the refusal through the per-day fold too', async () => {
    const w = futureWindow(30);
    const agg = await aggregate(`/calendar?from=${w.from}&to=${w.to}&group=day`);
    expect(agg.limits.projection.refused).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. The one-shot is a commitment, not a prediction.
// ---------------------------------------------------------------------------
describe('a one-shot booking is never drawn as a projection', () => {
  beforeAll(() => clearSeed());
  afterAll(() => clearSeed());

  it('marks a `once` schedule booked, because the row IS the commitment', async () => {
    const w = futureWindow(30);
    const at = w.from + 5 * DAY_MS + 10 * 3_600_000;
    seedTask({ name: 'One-shot audit', kind: 'once', runAt: at, nextFire: at });
    const body = await detail(`/calendar?from=${w.from}&to=${w.to}`);
    expect(body.bookings.map((b) => ({ at: b.at, projected: b.projected }))).toEqual([
      { at, projected: false },
    ]);
    // And a one-shot never dilutes the recurring schedules' share of the budget.
    expect(body.limits.projection.perSchedule).toBe(30 * CALENDAR_PROJECTION_PER_DAY);
  });
});

// ---------------------------------------------------------------------------
// 7. The primitive underneath: `limit` now bounds the WALK, and says so.
// ---------------------------------------------------------------------------
describe('occurrencesBetweenBounded reports the bound it applied', () => {
  const from = Date.UTC(2026, 0, 1);
  const daily = { kind: 'rrule' as const, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'UTC' };

  it('is not truncated when the window holds exactly `limit`', () => {
    // Ten days, ten occurrences, asked for ten. The `limit + 1` probe is what
    // keeps this from reading as a cut answer.
    const got = occurrencesBetweenBounded(daily, from, from + 10 * DAY_MS, 10);
    expect(got.occurrences).toHaveLength(10);
    expect(got.truncated).toBe(false);
  });

  it('is truncated when the window holds one more than `limit`', () => {
    const got = occurrencesBetweenBounded(daily, from, from + 11 * DAY_MS, 10);
    expect(got.occurrences).toHaveLength(10);
    expect(got.truncated).toBe(true);
  });

  it('returns the EARLIEST `limit`, not an arbitrary slice of the window', () => {
    const capped = occurrencesBetweenBounded(daily, from, from + 30 * DAY_MS, 5);
    const whole = occurrencesBetweenBounded(daily, from, from + 30 * DAY_MS, 500);
    expect(capped.occurrences).toEqual(whole.occurrences.slice(0, 5));
    expect(whole.truncated).toBe(false);
  });

  it('stops a per-minute rule at `limit` instead of walking the whole year', () => {
    // 525,600 occurrences exist in this window; the walk is allowed 100. The
    // COST of that is the bench's business, not this file's — what is pinned
    // here is that the answer is bounded and admits it.
    const minutely = { kind: 'rrule' as const, rrule: 'FREQ=MINUTELY', tz: 'UTC' };
    const got = occurrencesBetweenBounded(minutely, from, from + 365 * DAY_MS, 100);
    expect(got.occurrences).toHaveLength(100);
    expect(got.truncated).toBe(true);
    // Contiguous minutes from the start of the window: the earliest 100, not a
    // sample and not the far end.
    expect(got.occurrences[99]! - got.occurrences[0]!).toBe(99 * 60_000);
  });

  it('reports the cron branch’s own 200-step ceiling instead of hiding it', () => {
    // Pre-existing behaviour: cron never walks more than 200 steps whatever
    // `limit` says. It used to return 200 rows and no hint that it had stopped.
    const hourly = { kind: 'cron' as const, cron: '0 * * * *', tz: 'UTC' };
    const got = occurrencesBetweenBounded(hourly, from, from + 30 * DAY_MS, 5_000);
    expect(got.occurrences).toHaveLength(200);
    expect(got.truncated).toBe(true);
  });
});
