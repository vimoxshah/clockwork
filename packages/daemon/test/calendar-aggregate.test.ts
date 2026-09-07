/**
 * S-64 — per-day calendar aggregation and a bounded `GET /calendar` payload.
 *
 * WHAT THIS FILE PINS
 *   1. `?group=day` answers with COUNTS PER DAY, not events: one row per day
 *      that holds something, with the outcome breakdown a month or year cell
 *      needs to colour itself. The run rows themselves are not shipped.
 *   2. The aggregate is the DETAIL VIEW COLLAPSED — never a second, differently
 *      computed answer. The load-bearing test re-buckets the detail response in
 *      JS and demands the two agree exactly, which also makes the whole file
 *      timezone-agnostic: it never names a day, it derives every day key with
 *      the same local-calendar rule the UI uses.
 *   3. No window can return an unbounded number of rows, and a capped answer
 *      SAYS SO. `limits.truncated` plus per-collection `returned`/`total` is
 *      the difference between a bound and a silent lie.
 *   4. The detail view still works and still answers the shape it answered
 *      before, so the day panel keeps showing a day's actual runs.
 *
 * NOT MEASURED HERE. Latency lives in `calendar-aggregate-bench.test.ts`
 * against a 5,000-run corpus. This file is correctness only, on a corpus small
 * enough to stay inside the default suite.
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
import { buildServer, CALENDAR_ROW_LIMIT, calendarOutcomeBucket } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { RUN_STATES, type RunState } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const DAY_MS = 86_400_000;

let db: DB;
let dataDir: string;
let app: FastifyInstance;
let token: string;

// ---------------------------------------------------------------------------
// The response contract, restated here rather than imported: this file is the
// consumer's view of the route, and a shape change should have to be written
// down in two places.
// ---------------------------------------------------------------------------
interface CollectionLimit {
  returned: number;
  total: number;
  truncated: boolean;
}
interface Limits {
  rowLimit: number;
  truncated: boolean;
  runs: CollectionLimit;
  bookings: CollectionLimit;
  humans: CollectionLimit;
  days?: CollectionLimit;
}
interface DayRow {
  day: string;
  runs: number;
  bookings: number;
  humans: number;
  costUsd: number;
  outcomes: {
    completed: number;
    failed: number;
    cancelled: number;
    running: number;
    needsYou: number;
    other: number;
  };
}
interface DetailBody {
  from: number;
  to: number;
  runs: Array<Record<string, unknown>>;
  bookings: Array<{ taskId: string; name: string; at: number; kind: 'booking' }>;
  humans: Array<{ uid: string; name: string; at: number; allDay: boolean }>;
  limits: Limits;
}
interface AggregateBody {
  from: number;
  to: number;
  group: 'day';
  days: DayRow[];
  limits: Limits;
  runs?: unknown;
}

/**
 * The local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * This is the SAME rule the calendar grid uses (`todayMidnight` in
 * `packages/ui/src/calendar.ts` snaps to LOCAL midnight), and it is why no
 * assertion below hardcodes a date: bucketing has to agree with the reader's
 * calendar, not with UTC, or a run at 23:30 lands in tomorrow's cell.
 */
function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A LOCAL midnight, built from calendar fields rather than by adding
 * `86_400_000` to something.
 *
 * Two bugs this avoids, both of which reddened the first run of this file:
 * an anchor of `Date.now() - 40 * DAY_MS` carries the current time of day, so
 * `anchor + 11h` lands on tomorrow whenever the suite runs after 13:00; and
 * `midnight + 2 * DAY_MS` is 23:00 or 01:00, not midnight, across a DST
 * transition. Every date below is therefore mid-January or mid-July, where no
 * zone changes offset, and every day is named, never arithmetic.
 */
function localMidnight(y: number, m: number, d: number): number {
  return new Date(y, m, d).getTime();
}

let taskId: string;
let runSeq = 0;

function seedRun(opts: {
  scheduledFor: number;
  state?: string;
  costUsd?: number;
  task?: string;
}): string {
  const id = `agg-run-${String(runSeq++).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at,
                       cost_usd, turns, started_at, ended_at, scheduled_for, outcome_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, NULL)`,
  ).run(
    id,
    opts.task ?? taskId,
    opts.scheduledFor,
    JSON.stringify({ taskName: `Aggregate task ${runSeq}` }),
    opts.state ?? 'completed',
    opts.scheduledFor,
    opts.costUsd ?? 0,
    opts.scheduledFor,
    opts.scheduledFor + 60_000,
    opts.scheduledFor,
  );
  return id;
}

function auth(req: { method: string; url: string }): {
  method: string;
  url: string;
  headers: Record<string, string>;
} {
  return { ...req, headers: { authorization: `Bearer ${token}` } };
}

async function detail(url: string): Promise<DetailBody> {
  const res = await app.inject(auth({ method: 'GET', url }));
  expect(res.statusCode, res.payload.slice(0, 300)).toBe(200);
  return res.json() as DetailBody;
}

async function aggregate(url: string): Promise<AggregateBody> {
  const res = await app.inject(auth({ method: 'GET', url }));
  expect(res.statusCode, res.payload.slice(0, 300)).toBe(200);
  return res.json() as AggregateBody;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cw-cal-agg-'));
  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();

  taskId = 'agg-task-1';
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, created_at, updated_at)
     VALUES (?, 'Aggregate task', 'p', '/tmp/agg', ?, ?)`,
  ).run(taskId, Date.now(), Date.now());

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
// 1. The aggregate IS the detail view, collapsed.
// ---------------------------------------------------------------------------
describe('the per-day aggregate is the detail response folded, not a second answer', () => {
  // 6, 8 and 9 January 2025 — the 7th is deliberately left empty.
  const d0 = localMidnight(2025, 0, 6);
  const d2 = localMidnight(2025, 0, 8);
  const d3 = localMidnight(2025, 0, 9);
  const from = localMidnight(2025, 0, 5);
  const to = localMidnight(2025, 0, 12);

  beforeAll(() => {
    // Three days with runs, one day deliberately empty between them, mixed
    // states and costs so every bucket and the cost sum are exercised.
    seedRun({ scheduledFor: d0 + 9 * 3_600_000, state: 'completed', costUsd: 1.25 });
    seedRun({ scheduledFor: d0 + 11 * 3_600_000, state: 'failed', costUsd: 0.5 });
    seedRun({ scheduledFor: d0 + 13 * 3_600_000, state: 'timed_out', costUsd: 0.25 });
    seedRun({ scheduledFor: d2 + 3_600_000, state: 'completed', costUsd: 2 });
    seedRun({ scheduledFor: d2 + 7_200_000, state: 'cancelled', costUsd: 0 });
    seedRun({ scheduledFor: d3 + 3_600_000, state: 'waiting_approval', costUsd: 0.75 });
  });

  it('returns one row per day that holds something — and no row for an empty day', async () => {
    const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);
    expect(agg.group).toBe('day');
    const days = agg.days.map((d) => d.day);
    expect(days, 'the empty day between the seeded ones must not be shipped').toEqual([
      localDay(d0),
      localDay(d2),
      localDay(d3),
    ]);
    expect(days, 'days must arrive in calendar order').toEqual([...days].sort());
  });

  it('ships no run rows at all in aggregate mode — that is the whole point', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/calendar?from=${from}&to=${to}&group=day` }));
    const body = res.json() as AggregateBody;
    expect(body.runs, 'aggregate mode must not carry per-run rows').toBeUndefined();
    // And the payload has to actually be smaller than the events it replaces.
    const detailRes = await app.inject(auth({ method: 'GET', url: `/calendar?from=${from}&to=${to}` }));
    expect(Buffer.byteLength(res.payload)).toBeLessThan(Buffer.byteLength(detailRes.payload));
  });

  it('agrees with the detail response run-for-run, day-for-day, cent-for-cent', async () => {
    const det = await detail(`/calendar?from=${from}&to=${to}`);
    const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);

    // Re-derive the aggregate from the detail rows with the UI's own local-day
    // rule. If the route bucketed in UTC, or coalesced a different timestamp,
    // this comparison is what catches it.
    const expected = new Map<string, { runs: number; costUsd: number; buckets: Record<string, number> }>();
    for (const r of det.runs) {
      const at = (r.scheduled_for ?? r.started_at ?? r.ended_at) as number;
      const key = localDay(at);
      const cur = expected.get(key) ?? { runs: 0, costUsd: 0, buckets: {} };
      cur.runs += 1;
      cur.costUsd += Number(r.cost_usd ?? 0);
      const bucket = calendarOutcomeBucket(String(r.state));
      cur.buckets[bucket] = (cur.buckets[bucket] ?? 0) + 1;
      expected.set(key, cur);
    }

    expect(agg.days.map((d) => d.day)).toEqual([...expected.keys()].sort());
    for (const d of agg.days) {
      const want = expected.get(d.day)!;
      expect(d.runs, `run count for ${d.day}`).toBe(want.runs);
      expect(d.costUsd, `cost for ${d.day}`).toBeCloseTo(want.costUsd, 5);
      for (const [bucket, n] of Object.entries(want.buckets)) {
        expect(d.outcomes[bucket as keyof DayRow['outcomes']], `${bucket} on ${d.day}`).toBe(n);
      }
      const summed = Object.values(d.outcomes).reduce((a, b) => a + b, 0);
      expect(summed, `outcome buckets on ${d.day} must account for every run`).toBe(d.runs);
    }
  });

  it('counts bookings on the day they fall, alongside the runs', async () => {
    // A one-shot schedule inside the window: the calendar expands it into a
    // booking, and the aggregate has to count it without shipping it.
    const at = d2 + 10 * 3_600_000;
    db.prepare(
      `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
       VALUES ('agg-sched-once', ?, 'once', NULL, NULL, ?, 'UTC', ?, 1)`,
    ).run(taskId, at, at);
    try {
      const det = await detail(`/calendar?from=${from}&to=${to}`);
      const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);
      const byDay = new Map(agg.days.map((d) => [d.day, d]));
      expect(det.bookings.length, 'the one-shot must appear as a booking in detail mode').toBe(1);
      expect(byDay.get(localDay(at))!.bookings).toBe(1);
      const elsewhere = agg.days.filter((d) => d.day !== localDay(at));
      expect(elsewhere.every((d) => d.bookings === 0), 'no other day may claim a booking').toBe(true);
    } finally {
      db.prepare(`DELETE FROM schedules WHERE id = 'agg-sched-once'`).run();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every run state colours a cell — no state falls through unaccounted.
// ---------------------------------------------------------------------------
describe('the outcome breakdown accounts for every run state the FSM can produce', () => {
  const day = localMidnight(2025, 0, 20);
  const from = localMidnight(2025, 0, 19);
  const to = localMidnight(2025, 0, 21);

  beforeAll(() => {
    for (const [i, state] of RUN_STATES.entries()) {
      seedRun({ scheduledFor: day + (i + 1) * 60_000, state, costUsd: 0.01 });
    }
  });

  it('puts every one of the 13 FSM states in exactly one bucket', () => {
    const seen = new Map<RunState, string>();
    for (const s of RUN_STATES) seen.set(s, calendarOutcomeBucket(s));
    // The mapping the CALENDAR CELL needs, which is `stateClass()` in
    // CalendarView.tsx: `missed` is drawn like a cancellation, and anything
    // outside the five named groups (today: `scheduled`) falls to `other`,
    // which the cell renders with the same fallback class.
    expect(Object.fromEntries(seen)).toEqual({
      completed: 'completed',
      failed: 'failed',
      timed_out: 'failed',
      budget_exceeded: 'failed',
      cancelled: 'cancelled',
      missed: 'cancelled',
      running: 'running',
      queued: 'running',
      preparing: 'running',
      finalizing: 'running',
      waiting_approval: 'needsYou',
      awaiting_user: 'needsYou',
      scheduled: 'other',
    });
  });

  it('sums its buckets back to the run count, with one run in each state', async () => {
    const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);
    const row = agg.days.find((d) => d.day === localDay(day + 60_000));
    expect(row, 'the seeded day is missing from the aggregate').toBeTruthy();
    expect(row!.runs).toBe(RUN_STATES.length);
    const o = row!.outcomes;
    expect(o.completed).toBe(1);
    expect(o.failed).toBe(3); // failed, timed_out, budget_exceeded
    expect(o.cancelled).toBe(2); // cancelled, missed
    expect(o.running).toBe(4); // running, queued, preparing, finalizing
    expect(o.needsYou).toBe(2); // waiting_approval, awaiting_user
    expect(o.other).toBe(1); // scheduled
    expect(Object.values(o).reduce((a, b) => a + b, 0)).toBe(row!.runs);
  });
});

// ---------------------------------------------------------------------------
// 3. Midnight. The one place a per-day fold can be wrong by a whole cell.
// ---------------------------------------------------------------------------
describe('day boundaries are the reader’s local midnight, not UTC midnight', () => {
  // June, so no timezone on earth changes offset on these two dates.
  const lateNight = new Date(2026, 5, 15, 23, 59, 59).getTime();
  const justAfter = new Date(2026, 5, 16, 0, 0, 1).getTime();

  beforeAll(() => {
    seedRun({ scheduledFor: lateNight, state: 'completed', costUsd: 0.1 });
    seedRun({ scheduledFor: justAfter, state: 'completed', costUsd: 0.2 });
  });

  it('splits two runs two seconds apart into two days', async () => {
    const from = localMidnight(2026, 5, 15);
    const to = localMidnight(2026, 5, 17);
    const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);
    const days = agg.days.filter((d) => d.runs > 0);
    expect(days.map((d) => d.day)).toEqual([localDay(lateNight), localDay(justAfter)]);
    expect(days[0]!.runs).toBe(1);
    expect(days[1]!.runs).toBe(1);
    // The key must be parseable back to the local midnight the grid uses.
    const [y, m, dd] = days[0]!.day.split('-').map(Number);
    expect(new Date(y!, m! - 1, dd!).getTime()).toBe(new Date(2026, 5, 15).getTime());
  });
});

// ---------------------------------------------------------------------------
// 4. The bound, and the fact that a capped answer says it is capped.
// ---------------------------------------------------------------------------
describe('no window returns an unbounded payload, and a capped answer admits it', () => {
  // Ten consecutive days, 7-16 July 2025, one run each.
  const from = localMidnight(2025, 6, 6);
  const to = localMidnight(2025, 6, 18);

  beforeAll(() => {
    for (let i = 0; i < 10; i++) {
      seedRun({ scheduledFor: localMidnight(2025, 6, 7 + i) + 3_600_000, state: 'completed', costUsd: 0.1 });
    }
  });

  it('caps detail rows at the requested limit and reports returned vs total', async () => {
    const det = await detail(`/calendar?from=${from}&to=${to}&limit=3`);
    expect(det.runs.length).toBe(3);
    expect(det.limits.runs).toEqual({ returned: 3, total: 10, truncated: true });
    expect(det.limits.truncated, 'the caller must be able to tell the answer is partial').toBe(true);
    expect(det.limits.rowLimit).toBe(3);
  });

  it('caps aggregate day rows the same way, and counts the days it did not ship', async () => {
    const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day&limit=4`);
    expect(agg.days.length).toBe(4);
    expect(agg.limits.days).toEqual({ returned: 4, total: 10, truncated: true });
    expect(agg.limits.truncated).toBe(true);
    // The runs entry must describe the runs actually accounted for, not all 10.
    expect(agg.limits.runs.returned).toBe(agg.days.reduce((a, d) => a + d.runs, 0));
    expect(agg.limits.runs.total).toBe(10);
    expect(agg.limits.runs.truncated).toBe(true);
  });

  it('caps BOOKINGS too, and still reports the true total it counted', async () => {
    // The expansion half has its own unbounded growth: N enabled schedules x
    // up to 62 occurrences each. Capping the array while continuing to COUNT
    // is what lets the response say "2 of 3" instead of quietly dropping one.
    const at = (i: number) => localMidnight(2025, 6, 8 + i) + 10 * 3_600_000;
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
         VALUES (?, ?, 'once', NULL, NULL, ?, 'UTC', ?, 1)`,
      ).run(`agg-cap-once-${i}`, taskId, at(i), at(i));
    }
    try {
      const det = await detail(`/calendar?from=${from}&to=${to}&limit=2`);
      expect(det.bookings.length).toBe(2);
      expect(det.limits.bookings).toEqual({ returned: 2, total: 3, truncated: true });
      expect(det.limits.truncated).toBe(true);
      // The two it DID ship are the earliest, in order — not an arbitrary two.
      expect(det.bookings.map((b) => b.at)).toEqual([at(0), at(1)]);
      // And the fold counts all three, because counting is not what grows.
      const agg = await aggregate(`/calendar?from=${from}&to=${to}&group=day`);
      expect(agg.days.reduce((a, d) => a + d.bookings, 0)).toBe(3);
      expect(agg.limits.bookings).toEqual({ returned: 3, total: 3, truncated: false });
    } finally {
      db.prepare(`DELETE FROM schedules WHERE id LIKE 'agg-cap-once-%'`).run();
    }
  });

  it('says truncated:false — with exact totals — when nothing was cut', async () => {
    const det = await detail(`/calendar?from=${from}&to=${to}`);
    expect(det.limits.truncated).toBe(false);
    expect(det.limits.runs).toEqual({ returned: 10, total: 10, truncated: false });
    expect(det.limits.bookings.truncated).toBe(false);
    expect(det.limits.humans.truncated).toBe(false);
  });

  it('clamps a limit above the hard ceiling down to it — a caller cannot opt out of the bound', async () => {
    const det = await detail(`/calendar?from=${from}&to=${to}&limit=999999`);
    expect(det.limits.rowLimit).toBe(CALENDAR_ROW_LIMIT);
    expect(CALENDAR_ROW_LIMIT).toBeLessThanOrEqual(5_000);
  });

  it('applies the hard ceiling with no limit parameter at all', async () => {
    const det = await detail(`/calendar?from=${from}&to=${to}`);
    expect(det.limits.rowLimit).toBe(CALENDAR_ROW_LIMIT);
  });

  it('refuses a limit that is not a positive integer instead of guessing', async () => {
    for (const bad of ['abc', '0', '-5', '2.5', '']) {
      const res = await app.inject(
        auth({ method: 'GET', url: `/calendar?from=${from}&to=${to}&limit=${bad}` }),
      );
      expect(res.statusCode, `limit=${JSON.stringify(bad)} should be refused`).toBe(422);
      expect((res.json() as { error: string }).error).toBe('invalid limit');
    }
  });

  it('refuses a group it cannot compute rather than silently answering events', async () => {
    const res = await app.inject(
      auth({ method: 'GET', url: `/calendar?from=${from}&to=${to}&group=week` }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('invalid group');
  });

  it('a from=1 window folds to the days that hold data, not to one row per day since 1970', async () => {
    const agg = await aggregate(`/calendar?from=1&to=${Date.now() + DAY_MS}&group=day`);
    // ~20,000 days have elapsed since epoch; the corpus touches a handful.
    expect(agg.days.length).toBeLessThan(60);
    expect(agg.days.length).toBeGreaterThan(0);
    expect(agg.days.every((d) => d.runs > 0 || d.bookings > 0 || d.humans > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The detail view — the one in-repo consumer — keeps working unchanged.
// ---------------------------------------------------------------------------
describe('the detail view is unchanged, so clicking a day still shows its runs', () => {
  const day = localMidnight(2025, 6, 24);

  beforeAll(() => {
    seedRun({ scheduledFor: day + 9 * 3_600_000, state: 'completed', costUsd: 0.4 });
    seedRun({ scheduledFor: day + 15 * 3_600_000, state: 'failed', costUsd: 0.6 });
  });

  it('answers a single-day window with that day’s actual runs', async () => {
    // Exactly what the year view's day click sends: local midnight to the last
    // millisecond of the same local day.
    const [y, m, d] = localDay(day + 9 * 3_600_000).split('-').map(Number);
    const midnight = new Date(y!, m! - 1, d!).getTime();
    const nextMidnight = new Date(y!, m! - 1, d! + 1).getTime();
    const det = await detail(`/calendar?from=${midnight}&to=${nextMidnight - 1}`);
    expect(det.runs.length).toBe(2);
    expect(det.runs[0]!.task_name, 'the frozen snapshot name still rides along').toMatch(
      /^Aggregate task /,
    );
    expect(det.runs[0]!, 'the windowed projection must not regain the jobspec blob').not.toHaveProperty(
      'jobspec_json',
    );
    expect(det.runs.map((r) => r.state)).toEqual(['completed', 'failed']);
  });

  it('still carries runs, bookings and humans by those names', async () => {
    const det = await detail(`/calendar?from=${localMidnight(2025, 6, 23)}&to=${localMidnight(2025, 6, 25)}`);
    expect(Array.isArray(det.runs)).toBe(true);
    expect(Array.isArray(det.bookings)).toBe(true);
    expect(Array.isArray(det.humans)).toBe(true);
  });

  it('still refuses an inverted or missing range', async () => {
    for (const q of ['from=100&to=50', 'from=0&to=0', 'from=-5&to=-1']) {
      const res = await app.inject(auth({ method: 'GET', url: `/calendar?${q}` }));
      expect(res.statusCode, q).toBe(422);
      expect((res.json() as { error: string }).error).toBe('invalid range');
    }
  });
});
