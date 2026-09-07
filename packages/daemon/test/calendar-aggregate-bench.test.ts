/**
 * S-64 measured: what the per-day fold actually buys, on a 5,000-run corpus.
 *
 * WHY A SECOND BENCH FILE. `workforce-bench.test.ts` measures the DETAIL year
 * view and records the T-307 finding. When this file was written that finding
 * was: the year view's median moved between 349.59ms and 684.26ms on one
 * machine at one commit, decided by machine load, and an 8.8x payload cut
 * (`jobspec_json` → `task_name`) did not move latency at all, because the cost
 * was CPU inside RRULE expansion rather than serialization. This file measures
 * the aggregate against the detail view on ONE corpus in ONE process, so the
 * comparison is not exposed to that spread — a before/after pair taken minutes
 * apart on a laptop would tell you about the laptop. That reasoning is why the
 * file survives the fix below unchanged in structure.
 *
 * WHAT IS AND IS NOT CLAIMED
 *   - Rows and BYTES are properties of the code. They are asserted, always.
 *   - LATENCY is a property of the machine as much as the code, so every
 *     wall-clock bound here goes through `helpers/bench-gate.ts` exactly as in
 *     `workforce-bench.test.ts`: measured and printed by default, asserted only
 *     under `CLOCKWORK_BENCH_ASSERT=1`.
 *   - WHAT THE FOLD MOVES, AND WHEN. Both modes must decide which days hold
 *     bookings, so both pay the same booking expansion; only the runs half
 *     differs. While `recurrence.ts` anchored a DTSTART-less rule at 1970, that
 *     shared half was a 56-year replay that swamped the request, and the fold —
 *     which really does make the runs half ~2.6x cheaper — was invisible end to
 *     end. The replay is gone (`advancedAnchorMs`), so the same fold now shows:
 *     measured 2026-09-07 on an Apple M4 across three full runs, 27.11-29.29ms
 *     as events against 8.15-13.21ms as counts, with the runs half alone
 *     18.11-19.27ms against 4.68-7.52ms. The fold did not change; what it was
 *     hidden behind did. The `runs half only` cases isolate
 *     that half so the handback can name where the time went instead of
 *     guessing.
 *
 * CORPUS. Deliberately leaner than `workforce-bench.test.ts`: no FTS index and
 * no `run_outcomes`, because `GET /calendar` reads neither. The dimensions it
 * DOES share are the ones the route touches — 5,000 runs spread over 300 days
 * with real `buildJobSpec` payloads, 10 daily + 10 weekly RRULE schedules and
 * 40 one-shots. So the absolute numbers here are not comparable with that
 * file's; the detail-vs-aggregate pair inside this file is.
 *
 * DETERMINISM. mulberry32, no `Math.random`. The anchor is today's UTC
 * midnight, so the window always covers the whole corpus.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Scheduler, buildJobSpec } from '../src/scheduler.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, CALENDAR_ROW_LIMIT } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { assertLatency } from './helpers/bench-gate.js';

// Same reasoning as workforce-bench.test.ts: seeding 5,000 runs and then
// sampling a ~350ms request repeatedly does not fit the package's 30s default,
// and a timeout would report "your laptop was busy" as a code failure. This
// raises the ceiling on measurement cost; it loosens no assertion.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const RUN_COUNT = 5_000;
const TASK_COUNT = 60;
const RRULE_SCHEDULES = 20;
const ONCE_SCHEDULES = 40;
const HISTORY_DAYS = 300;
const DAY_MS = 86_400_000;
const ANCHOR = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const YEAR_FROM = ANCHOR - 365 * DAY_MS;
const YEAR_TO = ANCHOR + 31 * DAY_MS;

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stats {
  median: number;
  p95: number;
  min: number;
  max: number;
  n: number;
}

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const p95 = s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
  return { median, p95, min: s[0]!, max: s[s.length - 1]!, n: s.length };
}

function report(label: string, st: Stats): Stats {
  console.info(
    `[bench] ${label}: median ${st.median.toFixed(2)}ms | p95 ${st.p95.toFixed(2)}ms | ` +
      `min ${st.min.toFixed(2)}ms | max ${st.max.toFixed(2)}ms | n=${st.n}`,
  );
  return st;
}

function bench(label: string, fn: () => unknown, iters = 15, warmup = 2): Stats {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return report(label, stats(samples));
}

async function timeOnce(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

/**
 * Measure two candidates INTERLEAVED, alternating which one goes first.
 *
 * THE BUG THIS EXISTS FOR, found while measuring this change. The first
 * version of this file benched the detail mode to completion and then the
 * aggregate mode, five samples each. Across three runs it reported the
 * aggregate 1.6%, 17.7% and 6.6% SLOWER end to end — consistently, in the same
 * direction — while the isolated runs-half case said the aggregate's SQL and
 * serialization are ~6ms CHEAPER. Both cannot be true of the same code, and
 * the difference between them was measurement ORDER: whichever mode is sampled
 * second pays for the GC pressure the first one built up serializing six 1.1MB
 * payloads. A sequential A-then-B harness cannot separate that from a real
 * regression, so it was not evidence either way.
 *
 * Alternating removes the confound instead of arguing about it: neither
 * candidate systematically follows the other, so drift and GC land on both.
 * Five samples and one warmup pair: that was chosen when each sample cost
 * ~350ms of wall clock and this file runs inside the default suite. A sample is
 * ~29ms now that the RRULE replay is gone, so the sample count is left where it
 * is — raising it would change what the numbers below can be compared against,
 * for no measurement benefit.
 */
async function benchPaired(
  labelA: string,
  fnA: () => Promise<unknown>,
  labelB: string,
  fnB: () => Promise<unknown>,
  iters = 5,
  warmup = 1,
): Promise<{ a: Stats; b: Stats }> {
  for (let i = 0; i < warmup; i++) {
    await fnA();
    await fnB();
  }
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < iters; i++) {
    if (i % 2 === 0) {
      a.push(await timeOnce(fnA));
      b.push(await timeOnce(fnB));
    } else {
      b.push(await timeOnce(fnB));
      a.push(await timeOnce(fnA));
    }
  }
  return { a: report(labelA, stats(a)), b: report(labelB, stats(b)) };
}

const WORDS = [
  'repository', 'report', 'migration', 'schema', 'index', 'query', 'transaction', 'scheduler',
  'occurrence', 'ledger', 'worktree', 'branch', 'commit', 'diffstat', 'sandbox', 'permission',
];
const STATES = ['completed', 'completed', 'completed', 'completed', 'failed', 'timed_out', 'cancelled'];

interface Corpus {
  db: DB;
  dir: string;
  app: FastifyInstance;
  token: string;
}
let corpus: Corpus;

function seedCorpus(db: DB): void {
  const rnd = mulberry32(0x5_64_5eed);
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, name, prompt, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO runs (id, task_id, occurrence_at, schedule_id, jobspec_json, state, state_changed_at,
                       branch, cost_usd, turns, started_at, ended_at, scheduled_for, outcome_reason, report_json)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertSchedule = db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
  );

  const tx = db.transaction(() => {
    const taskIds: string[] = [];
    for (let t = 0; t < TASK_COUNT; t++) {
      const id = `s64-task-${String(t).padStart(3, '0')}`;
      const prose = Array.from({ length: 30 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
      insertTask.run(id, `Bench task ${t}`, prose, `/tmp/s64-repo-${t % 12}`, ANCHOR, ANCHOR);
      taskIds.push(id);
    }

    // Real jobspecs through the production builder, so `json_extract(...,
    // '$.taskName')` reads the same path and the blob is the size a real run
    // stores — the detail view's payload is mostly this.
    const baseSpecs = new Map<string, ReturnType<typeof buildJobSpec>>();
    for (const taskId of taskIds) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as never;
      baseSpecs.set(taskId, buildJobSpec(`${taskId}-spec`, row, ANCHOR, ANCHOR, db));
    }

    for (let i = 0; i < RUN_COUNT; i++) {
      const runId = `s64-run-${String(i).padStart(5, '0')}`;
      const taskId = taskIds[i % TASK_COUNT]!;
      const base = baseSpecs.get(taskId)!;
      const scheduledFor = ANCHOR - Math.floor(rnd() * HISTORY_DAYS * DAY_MS);
      const startedAt = scheduledFor + Math.floor(rnd() * 20_000);
      const endedAt = startedAt + 30_000 + Math.floor(rnd() * 600_000);
      const state = STATES[Math.floor(rnd() * STATES.length)]!;
      const costUsd = Math.round(rnd() * 400) / 100;
      const spec = { ...base, runId, occurrenceAt: scheduledFor, scheduledFor, createdAt: scheduledFor };
      insertRun.run(
        runId,
        taskId,
        scheduledFor,
        JSON.stringify(spec),
        state,
        endedAt,
        `clockwork/s64/${runId}`,
        costUsd,
        1 + Math.floor(rnd() * 40),
        startedAt,
        endedAt,
        scheduledFor,
        state === 'completed' ? null : 'transient',
      );
    }

    // The expansion half of the handler. Without these the measurement would
    // skip the part that dominates it.
    for (let s = 0; s < RRULE_SCHEDULES; s++) {
      const daily = s % 2 === 0;
      insertSchedule.run(
        `s64-sched-${s}`,
        taskIds[s]!,
        'rrule',
        daily ? 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0' : 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30',
        null,
        'UTC',
        ANCHOR + DAY_MS,
      );
    }
    for (let s = 0; s < ONCE_SCHEDULES; s++) {
      const at = ANCHOR + (1 + s) * DAY_MS * 0.5;
      insertSchedule.run(`s64-sched-once-${s}`, taskIds[20 + (s % 40)]!, 'once', null, at, 'UTC', at);
    }
  });
  tx();
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-s64-bench-'));
  const opened = openDatabase(dir);
  const db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();

  const t0 = performance.now();
  seedCorpus(db);
  console.info(`[bench] S-64 corpus seed (${RUN_COUNT} runs): ${(performance.now() - t0).toFixed(0)}ms`);

  const clock = new FakeClock(ANCHOR);
  const runManager = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager, scheduler, version: 'bench' });
  await built.app.ready();
  corpus = { db, dir, app: built.app, token: built.token };
});

afterAll(async () => {
  await corpus.app.close();
  corpus.db.close();
  rmSync(corpus.dir, { recursive: true, force: true });
});

function get(url: string): Promise<{ statusCode: number; payload: string; json: () => unknown }> {
  return corpus.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${corpus.token}` },
  }) as unknown as Promise<{ statusCode: number; payload: string; json: () => unknown }>;
}

const YEAR_DETAIL = `/calendar?from=${YEAR_FROM}&to=${YEAR_TO}`;
const YEAR_AGGREGATE = `${YEAR_DETAIL}&group=day`;

describe('corpus integrity (a fast query over an empty table proves nothing)', () => {
  it('holds exactly 5,000 runs and a populated schedule set', () => {
    const runs = (corpus.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    const scheds = (corpus.db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number }).n;
    expect(runs).toBe(RUN_COUNT);
    expect(scheds).toBe(RRULE_SCHEDULES + ONCE_SCHEDULES);
  });
});

// ---------------------------------------------------------------------------
// S-64 — the whole point, measured both ways.
// ---------------------------------------------------------------------------
describe('S-64 — a year view over 5,000 runs, as events vs as counts per day', () => {
  let detailBytes = 0;
  let aggregateBytes = 0;

  it('the DETAIL year view ships one row per run — the shape being replaced', async () => {
    const res = await get(YEAR_DETAIL);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runs: unknown[];
      bookings: unknown[];
      limits: { rowLimit: number; truncated: boolean; runs: { returned: number; total: number } };
    };
    detailBytes = Buffer.byteLength(res.payload);
    console.info(
      `[bench] S-64 detail year view: ${body.runs.length} run rows + ${body.bookings.length} bookings, ` +
        `payload ${(detailBytes / 1_048_576).toFixed(3)}MB`,
    );
    expect(body.runs.length).toBe(RUN_COUNT); // the whole history, per S-64
    expect(body.bookings.length).toBeGreaterThan(100); // the RRULE expansion really runs
    // 5,000 is the ceiling and this corpus sits exactly at it, so the answer is
    // complete — the bound is a bound, not a silent cut.
    expect(body.limits.rowLimit).toBe(CALENDAR_ROW_LIMIT);
    expect(body.limits.truncated).toBe(false);
    expect(body.limits.runs).toMatchObject({ returned: RUN_COUNT, total: RUN_COUNT });
  });

  it('the AGGREGATE year view ships one row per day, and accounts for every run', async () => {
    const res = await get(YEAR_AGGREGATE);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: Array<{ day: string; runs: number; bookings: number; outcomes: Record<string, number> }>;
      limits: { truncated: boolean; runs: { returned: number; total: number } };
      runs?: unknown;
    };
    aggregateBytes = Buffer.byteLength(res.payload);
    console.info(
      `[bench] S-64 aggregate year view: ${body.days.length} day rows, ` +
        `payload ${(aggregateBytes / 1024).toFixed(1)}KB`,
    );

    expect(body.runs, 'no per-run rows may survive the fold').toBeUndefined();
    // A ~396-day window cannot hold more day rows than it has days.
    expect(body.days.length).toBeLessThanOrEqual(397);
    expect(body.days.length).toBeGreaterThan(200);
    // Nothing is lost: every one of the 5,000 runs is counted somewhere.
    expect(body.days.reduce((a, d) => a + d.runs, 0)).toBe(RUN_COUNT);
    expect(body.limits.runs).toEqual({ returned: RUN_COUNT, total: RUN_COUNT, truncated: false });
    expect(body.limits.truncated).toBe(false);
    // Bookings are folded in too, not dropped.
    expect(body.days.some((d) => d.bookings > 0)).toBe(true);
    for (const d of body.days) {
      expect(Object.values(d.outcomes).reduce((a, b) => a + b, 0), `buckets on ${d.day}`).toBe(d.runs);
    }
  });

  it('is at least 10x smaller on the wire — asserted, because bytes are the code’s doing', async () => {
    // Rows and bytes do not depend on how busy the laptop is, so unlike the
    // latency cases below this one asserts unconditionally. 10x is a floor with
    // room to spare; the real ratio is printed for the record.
    expect(detailBytes, 'run the detail case first').toBeGreaterThan(0);
    expect(aggregateBytes, 'run the aggregate case first').toBeGreaterThan(0);
    console.info(
      `[bench] S-64 payload: detail ${(detailBytes / 1_048_576).toFixed(3)}MB vs aggregate ` +
        `${(aggregateBytes / 1024).toFixed(1)}KB — ${(detailBytes / aggregateBytes).toFixed(1)}x smaller`,
    );
    expect(detailBytes / aggregateBytes).toBeGreaterThan(10);
  });

  it('LATENCY, both modes, same corpus, same process, interleaved — the honest half', async () => {
    const { a: detail, b: agg } = await benchPaired(
      'S-64 GET /calendar year view, DETAIL (5,000 run rows)',
      async () => {
        const res = await get(YEAR_DETAIL);
        expect(res.statusCode).toBe(200);
      },
      'S-64 GET /calendar year view, AGGREGATE (group=day)',
      async () => {
        const res = await get(YEAR_AGGREGATE);
        expect(res.statusCode).toBe(200);
      },
    );
    const delta = detail.median - agg.median;
    console.info(
      `[bench] S-64 latency: detail ${detail.median.toFixed(2)}ms vs aggregate ${agg.median.toFixed(2)}ms ` +
        `— aggregate is ${delta >= 0 ? 'faster' : 'SLOWER'} by ${Math.abs(delta).toFixed(2)}ms ` +
        `(${((Math.abs(delta) / detail.median) * 100).toFixed(1)}%). Detail spread ` +
        `${detail.min.toFixed(2)}-${detail.max.toFixed(2)}ms, aggregate spread ` +
        `${agg.min.toFixed(2)}-${agg.max.toFixed(2)}ms — read the delta against those, not on its own.`,
    );

    // NFR-3's 500ms median. Gated, and T-307 records why: at one commit on one
    // machine this bound held in six runs of ten and missed in four, decided by
    // `uptime` load. Both modes are an order of magnitude under it now, and the
    // gate still stands — a wall-clock assertion inside the default suite makes
    // the build's colour a property of the machine at any margin. A red here
    // means "this machine is busy, or this code got slower", and the bench
    // cannot tell you which.
    assertLatency('S-64 /calendar year view DETAIL (median, NFR-3: 500ms)', detail.median, 500);
    assertLatency('S-64 /calendar year view AGGREGATE (median, NFR-3: 500ms)', agg.median, 500);
  });

  it('the RUNS HALF alone, both modes — where the fold actually saves work', () => {
    // Isolates SQL + serialization from the booking expansion. This is the only
    // part of the handler the fold changes, so it is the only part where a
    // saving can exist; the total above says whether that saving is visible
    // next to everything else the route has to do. It was not visible while the
    // expansion replayed from 1970 and this half was ~3% of the request; it is
    // visible now that the replay is gone and this half is most of it.
    const windowArgs = [YEAR_FROM, YEAR_TO, YEAR_FROM, YEAR_TO, YEAR_FROM, YEAR_TO] as const;
    const WHERE = `(scheduled_for BETWEEN ? AND ?)
          OR (started_at BETWEEN ? AND ?)
          OR (ended_at BETWEEN ? AND ?)`;

    const detailStmt = corpus.db.prepare(
      `SELECT id, task_id, state, outcome_reason, scheduled_for, started_at, ended_at, cost_usd, turns,
              json_extract(jobspec_json, '$.taskName') AS task_name
       FROM runs
       WHERE ${WHERE}
       ORDER BY COALESCE(scheduled_for, started_at, ended_at) ASC
       LIMIT ?`,
    );
    const groupStmt = corpus.db.prepare(
      `SELECT strftime('%Y-%m-%d', COALESCE(scheduled_for, started_at, ended_at) / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS runs,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd,
              SUM(CASE WHEN state IN ('completed') THEN 1 ELSE 0 END) AS bucket_0,
              SUM(CASE WHEN state IN ('failed','timed_out','budget_exceeded') THEN 1 ELSE 0 END) AS bucket_1,
              SUM(CASE WHEN state IN ('cancelled','missed') THEN 1 ELSE 0 END) AS bucket_2,
              SUM(CASE WHEN state IN ('running','queued','preparing','finalizing') THEN 1 ELSE 0 END) AS bucket_3,
              SUM(CASE WHEN state IN ('waiting_approval','awaiting_user') THEN 1 ELSE 0 END) AS bucket_4
       FROM runs
       WHERE ${WHERE}
       GROUP BY day
       ORDER BY day ASC`,
    );

    const detailHalf = bench('S-64 runs half only, DETAIL (SQL + JSON of 5,000 rows)', () => {
      const rows = detailStmt.all(...windowArgs, CALENDAR_ROW_LIMIT + 1) as unknown[];
      expect(rows.length).toBe(RUN_COUNT);
      return JSON.stringify(rows);
    });
    const aggHalf = bench('S-64 runs half only, AGGREGATE (GROUP BY + JSON of day rows)', () => {
      const rows = groupStmt.all(...windowArgs) as unknown[];
      expect(rows.length).toBeGreaterThan(200);
      return JSON.stringify(rows);
    });
    console.info(
      `[bench] S-64 runs half: detail ${detailHalf.median.toFixed(2)}ms vs aggregate ` +
        `${aggHalf.median.toFixed(2)}ms — the fold saves ` +
        `${(detailHalf.median - aggHalf.median).toFixed(2)}ms of the request. Compare that with the ` +
        `end-to-end delta above: whatever is left is the RRULE expansion both modes pay.`,
    );
    assertLatency('S-64 runs half DETAIL (median, no claimed bound)', detailHalf.median, 500);
    assertLatency('S-64 runs half AGGREGATE (median, no claimed bound)', aggHalf.median, 500);
  });
});
