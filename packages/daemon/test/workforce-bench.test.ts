/**
 * Scale + performance benchmark for the two NEVER-MEASURED claims in
 * plan/STATUS.md, plus the two regression questions the twelve workforce
 * features raise.
 *
 * WHAT IS UNDER TEST
 *   T-113  full-text search over a 5,000-run corpus  < 100ms
 *          (plan/05-execution-plan.md:57 — "US-14 (inbox scope); 5k-run
 *          corpus <100ms"). Exercised through the EXACT SQL the /search route
 *          issues (api.ts:1205-1206), snippet() and `ORDER BY rank LIMIT 50`
 *          included, with the same `w*` prefix-term query the route builds.
 *   T-307  calendar windowing over 5,000 historical runs  < 500ms
 *          (NFR-3, plan/01-product-spec.md:91 — "calendar renders 5,000
 *          historical runs <500ms"; S-64 is the year view). Exercised through
 *          `app.inject('/calendar')`, i.e. the SQL, the RRULE expansion and
 *          the JSON serialization the daemon really pays.
 *   S-9    the 500-task / 50-due tick fixture must not regress behind the
 *          twelve workforce features. Same shape as scheduler.test.ts:317,
 *          measured here on its own DB so that fixture is untouched, and
 *          measured a SECOND time with F3 office-hours switched ON — the only
 *          workforce hook that sits inside the tick path
 *          (scheduler.ts:205, shiftForApproval).
 *   F10/F11 the timesheet and performance-review aggregates group runs by
 *          `COALESCE(run_outcomes.profile_id, json_extract(runs.jobspec_json,
 *          '$.profile.id'))`. json_extract cannot use an index, so both are
 *          full scans by construction. No claimed bound exists — these assert
 *          a generous ceiling so a gross regression trips, and REPORT the
 *          real number.
 *
 * LATENCY BOUNDS ARE OPT-IN — READ THIS BEFORE ADDING ONE
 *   A wall-clock bound asserted inside the default `pnpm test` makes the
 *   suite's colour a property of the machine rather than of the code. On
 *   2026-09-06, on one Apple M4 at one commit inside 90 minutes, six runs of
 *   THIS FILE under `CLOCKWORK_BENCH_ASSERT=1` split three red and three
 *   green: the S-64 bound below measured 623.17 / 684.26 / 579.59ms at
 *   `uptime` load 12.5-27.1 and 383.93 / 376.56 / 349.59ms at load 7.4-7.9,
 *   against 500ms. The default `pnpm test` was green in both conditions. Two
 *   verdicts for one commit, decided by machine load.
 *
 *   So every wall-clock bound in this file goes through `assertLatency`
 *   (`test/helpers/bench-gate.ts`):
 *     - DEFAULT: measure, print the number, print the verdict against the
 *       bound ("EXCEEDED (measured, not asserted)"), and do not fail.
 *     - `CLOCKWORK_BENCH_ASSERT=1`: assert the bound and fail if it is missed.
 *   Run the second form on an idle machine when you want the numbers to be a
 *   gate:  `CLOCKWORK_BENCH_ASSERT=1 npx vitest run test/workforce-bench.test.ts`
 *
 *   Correctness assertions are NOT gated and never should be: corpus counts,
 *   row counts, HTTP status codes and the response-shape guards assert
 *   unconditionally in both modes, because a benchmark that measures nothing
 *   real is worse than no benchmark.
 *
 * HONESTY RULES THIS FILE FOLLOWS
 *   - Every number printed is a measured `performance.now()` delta. Nothing is
 *     estimated. Each measurement warms up, then takes N samples and reports
 *     median AND p95 — a single sample is not a measurement.
 *   - Bounds carry headroom (claim bound on the median, ~3x on p95). The raw
 *     numbers go to stdout via console.info whether or not the bound held —
 *     a benchmark's numbers are its product, not its pass/fail.
 *   - Guard assertions prove the corpus is actually there (5,000 runs, 5,060
 *     FTS documents, a common term matching thousands of rows) so a query can
 *     never look fast because it found nothing.
 *
 * DETERMINISM
 *   Corpus CONTENT is fully deterministic: one seeded mulberry32 PRNG drives
 *   every choice (words, costs, states, profile assignment, outcome mix) and
 *   ids are generated positionally, so two runs build byte-identical rows
 *   modulo the epoch. Corpus EPOCH is anchored to today's UTC midnight rather
 *   than a frozen literal, because `/calendar` expands bookings from
 *   `Math.max(from, Date.now() - 1000)` (api.ts:1075): with a frozen past
 *   anchor the RRULE expansion would return nothing and the measurement would
 *   silently skip the most expensive half of the handler. Shifting the epoch
 *   changes no timing.
 *
 * COST
 *   One corpus, seeded once in one transaction in `beforeAll`, reused by every
 *   measurement. The S-9 replica gets its own small DB because a tick over the
 *   5k corpus would be measuring something else.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Scheduler, buildJobSpec } from '../src/scheduler.js';
import { RunManager } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { indexRun } from '../src/repo.js';
import { timesheet } from '../src/timesheets.js';
import { scorecard, scorecards } from '../src/performance.js';
import { SafetyJournal } from '@clockwork/runner';
import { assertLatency } from './helpers/bench-gate.js';

// ---------------------------------------------------------------------------
// TIMEOUT HEADROOM — the OTHER way a benchmark reddens the default suite.
//
// Gating the ASSERTIONS (`helpers/bench-gate.ts`) shut one door and left the
// second one open. These tests inherit `testTimeout: 30_000` from
// `packages/daemon/vitest.config.ts`, and the T-307 year view spends 1 probe +
// 2 warmups + 15 samples inside ONE `it()`: ~11s of that 30s budget at the
// 585ms median measured on an Apple M4, with a single sample already at
// 1196ms. A machine ~2.7x slower, or a loaded CI runner, blows the budget and
// the default suite goes red as a TIMEOUT instead of as an assertion — the
// same "your laptop was busy" verdict the gate exists to prevent, wearing a
// different hat.
//
// So this file buys its own budget. `vi.setConfig` is file-scoped (verified
// against vitest 2.1.9: a 50ms setting really did time a 400ms test out), and
// the hook budget is raised with it because `beforeAll` seeds the entire
// 5,000-run corpus under the DEFAULT 10s hook timeout, which nothing above
// ever widened. No bound is loosened by this and no assertion is skipped: a
// genuine hang still fails the suite, five minutes later instead of thirty
// seconds later.
// ---------------------------------------------------------------------------
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const RUN_COUNT = 5_000;
const TASK_COUNT = 60;
const PROFILE_COUNT = 6;
const RRULE_SCHEDULES = 20;
const HISTORY_DAYS = 300;
const DAY_MS = 86_400_000;

/** Today's UTC midnight — see "DETERMINISM" in the header. */
const ANCHOR = Math.floor(Date.now() / DAY_MS) * DAY_MS;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). No Math.random anywhere in this file.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
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
  const median = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const p95 = s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  return { median, p95, min: s[0], max: s[s.length - 1], n: s.length };
}

function report(label: string, st: Stats): Stats {
  console.info(
    `[bench] ${label}: median ${st.median.toFixed(2)}ms | p95 ${st.p95.toFixed(2)}ms | ` +
      `min ${st.min.toFixed(2)}ms | max ${st.max.toFixed(2)}ms | n=${st.n}`,
  );
  return st;
}

function bench(label: string, fn: () => unknown, iters = 25, warmup = 3): Stats {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return report(label, stats(samples));
}

async function benchAsync(label: string, fn: () => Promise<unknown>, iters = 15, warmup = 2): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return report(label, stats(samples));
}

// ---------------------------------------------------------------------------
// Corpus vocabulary. `repo` is the COMMON term: it prefixes `repository`,
// `report`, `reported`… so `repo*` matches nearly every document and FTS5 has
// to bm25-score thousands of rows before LIMIT 50 can cut. That is the case
// the <100ms claim actually has to survive. `cranberry` is the RARE term.
// ---------------------------------------------------------------------------
const WORDS = [
  'repository', 'report', 'reported', 'migration', 'schema', 'index', 'query', 'transaction',
  'scheduler', 'occurrence', 'ledger', 'worktree', 'branch', 'commit', 'diffstat', 'sandbox',
  'permission', 'approval', 'budget', 'turns', 'timeout', 'coverage', 'regression', 'fixture',
  'daemon', 'runner', 'profile', 'skill', 'prompt', 'summary', 'failure', 'retry',
  'dependency', 'lockfile', 'typecheck', 'lint', 'refactor', 'rename', 'inline', 'extract',
];

function prose(rnd: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return out.join(' ');
}

const STATES = ['completed', 'completed', 'completed', 'completed', 'failed', 'timed_out', 'cancelled'];

interface Corpus {
  db: DB;
  dir: string;
  app: FastifyInstance;
  token: string;
  profileIds: string[];
  taskIds: string[];
}

let corpus: Corpus;

function seedCorpus(db: DB): { profileIds: string[]; taskIds: string[] } {
  const rnd = mulberry32(0x5eed_1234);
  const profileIds: string[] = [];
  const taskIds: string[] = [];

  const insertProfile = db.prepare(
    `INSERT INTO profiles (id, slug, name, engine, skills_json, mcp_allow_json, context_roots_json, created_at, updated_at)
     VALUES (?, ?, ?, 'cli', ?, '[]', '[]', ?, ?)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, name, prompt, profile_id, repo_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO runs (id, task_id, occurrence_at, schedule_id, jobspec_json, state, state_changed_at,
                       branch, cost_usd, turns, started_at, ended_at, scheduled_for, outcome_reason, report_json)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertOutcome = db.prepare(
    `INSERT INTO run_outcomes (run_id, task_id, profile_id, decision, actor, decided_at) VALUES (?, ?, ?, ?, 'local', ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO search_idx (kind, ref_id, title, body) VALUES (?, ?, ?, ?)`,
  );
  const insertSchedule = db.prepare(
    `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
  );

  const tx = db.transaction(() => {
    for (let p = 0; p < PROFILE_COUNT; p++) {
      const id = `bench-profile-${p}`;
      insertProfile.run(id, `bench-profile-${p}`, `Bench Agent ${p}`, JSON.stringify(['review@1', 'deps@1']), ANCHOR, ANCHOR);
      profileIds.push(id);
    }

    for (let t = 0; t < TASK_COUNT; t++) {
      const id = `bench-task-${String(t).padStart(3, '0')}`;
      // Every 7th task has NO profile: it feeds the "Unassigned" group, which
      // is the json_extract-returns-NULL branch of F10/F11's grouping key.
      const profileId = t % 7 === 6 ? null : profileIds[t % PROFILE_COUNT];
      insertTask.run(
        id,
        `Bench task ${t}`,
        prose(rnd, 30),
        profileId,
        `/tmp/bench-repo-${t % 12}`,
        ANCHOR,
        ANCHOR,
      );
      taskIds.push(id);
      insertFts.run('task', id, `Bench task ${t}`, prose(rnd, 40));
    }

    // One real jobspec per task via the production builder, so `$.profile.id`,
    // `$.profile.slug` and `$.profile.name` are exactly the paths F10/F11 read
    // and the JSON is the shape/size a real run stores.
    const baseSpecs = new Map<string, ReturnType<typeof buildJobSpec>>();
    for (const taskId of taskIds) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as never;
      baseSpecs.set(taskId, buildJobSpec(`${taskId}-spec`, row, ANCHOR, ANCHOR, db));
    }

    for (let i = 0; i < RUN_COUNT; i++) {
      const runId = `bench-run-${String(i).padStart(5, '0')}`;
      const taskId = taskIds[i % TASK_COUNT];
      const base = baseSpecs.get(taskId)!;
      const profileId = base.profile?.id ?? null;

      // Spread the history backwards from the anchor so a 365-day window
      // covers all 5,000 and the endpoint's default 62-day window covers a
      // realistic recent slice.
      const scheduledFor = ANCHOR - Math.floor(rnd() * HISTORY_DAYS * DAY_MS);
      const startedAt = scheduledFor + Math.floor(rnd() * 20_000);
      const endedAt = startedAt + 30_000 + Math.floor(rnd() * 600_000);
      const state = STATES[Math.floor(rnd() * STATES.length)];
      const costUsd = Math.round(rnd() * 400) / 100;
      const turns = 1 + Math.floor(rnd() * 40);

      const spec = { ...base, runId, occurrenceAt: scheduledFor, scheduledFor, createdAt: scheduledFor };

      // Three documents in 5,000 carry the rare term.
      const summary =
        i % 1_700 === 0 ? `cranberry ${prose(rnd, 90)}` : prose(rnd, 90);

      const reportJson = JSON.stringify({
        runId,
        taskId,
        taskName: base.taskName,
        profile: base.profile ? { slug: base.profile.slug, name: base.profile.name, color: null, glyph: null } : null,
        engine: 'cli',
        cliVersion: '2.1.261',
        state,
        failureReason: state === 'completed' ? null : 'transient engine error',
        summary,
        branch: `clockwork/bench/${runId}`,
        baseSha: `${runId}0000000000000000000000000000000000`.slice(0, 40),
        basedOnLocalState: false,
        committedSomething: state === 'completed',
        sandboxed: true,
        worktreeState: null,
        diffStat: Array.from({ length: 8 }, (_, k) => ({
          path: `packages/daemon/src/${WORDS[(i + k) % WORDS.length]}.ts`,
          additions: 1 + ((i + k) % 90),
          deletions: (i + k) % 30,
          binary: false,
        })),
        artifacts: [],
        transcriptPath: `/tmp/bench/${runId}/transcript.jsonl`,
        costUsd,
        turns,
        softCapOvershootUsd: 0,
        startedAt,
        endedAt,
        ranLateMs: 0,
        coveredOccurrences: [],
        sleptThroughKeepAwake: false,
        approvals: [],
        timeline: Array.from({ length: 10 }, (_, k) => ({
          at: startedAt + k * 1_000,
          kind: 'usage' as const,
          text: prose(rnd, 8),
        })),
        deliveries: [],
        queueDelayMs: 0,
        repoLockDelayMs: 0,
      });

      insertRun.run(
        runId,
        taskId,
        scheduledFor,
        JSON.stringify(spec),
        state,
        endedAt,
        `clockwork/bench/${runId}`,
        costUsd,
        turns,
        startedAt,
        endedAt,
        scheduledFor,
        state === 'completed' ? null : 'transient',
        reportJson,
      );

      // Same title/body shape run-manager.ts:546 writes at finalize.
      insertFts.run('run', runId, base.taskName, `${summary}\n${state === 'completed' ? '' : 'transient engine error'}`);

      // ~30% of runs carry a human verdict, so the F10/F11 grouping key is
      // exercised on BOTH branches: run_outcomes.profile_id when present, the
      // jobspec_json fallback when not.
      const roll = rnd();
      if (roll < 0.3) {
        const decision = roll < 0.2 ? 'accepted' : roll < 0.26 ? 'accepted_with_note' : 'rejected';
        insertOutcome.run(runId, taskId, profileId, decision, endedAt);
      }
    }

    // Live bookings: RRULE schedules the calendar has to expand forward, plus
    // one-shots inside the window. Without these the /calendar measurement
    // would skip the whole expansion half of the handler.
    for (let s = 0; s < RRULE_SCHEDULES; s++) {
      const taskId = taskIds[s];
      const daily = s % 2 === 0;
      insertSchedule.run(
        `bench-sched-${s}`,
        taskId,
        'rrule',
        daily ? 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0' : 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30',
        null,
        'UTC',
        ANCHOR + DAY_MS,
      );
    }
    for (let s = 0; s < 40; s++) {
      const at = ANCHOR + (1 + s) * DAY_MS * 0.5;
      insertSchedule.run(`bench-sched-once-${s}`, taskIds[20 + (s % 40)], 'once', null, at, 'UTC', at);
    }
  });

  tx();
  return { profileIds, taskIds };
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-bench-'));
  const opened = openDatabase(dir);
  const db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();

  const t0 = performance.now();
  const { profileIds, taskIds } = seedCorpus(db);
  console.info(`[bench] corpus seed (${RUN_COUNT} runs + ${RUN_COUNT + TASK_COUNT} FTS docs): ${(performance.now() - t0).toFixed(0)}ms`);

  const clock = new FakeClock(ANCHOR);
  const runManager = new RunManager({
    db,
    clock,
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // never spawned: no run is started here
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager, scheduler, version: 'bench' });
  await built.app.ready();

  corpus = { db, dir, app: built.app, token: built.token, profileIds, taskIds };
}, 120_000);

afterAll(async () => {
  await corpus.app.close();
  corpus.db.close();
  rmSync(corpus.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('corpus integrity (a fast query over an empty table proves nothing)', () => {
  it('holds exactly 5,000 runs, 5,060 FTS documents and a populated schedule set', () => {
    const runs = (corpus.db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c;
    const docs = (corpus.db.prepare('SELECT COUNT(*) c FROM search_idx').get() as { c: number }).c;
    const outcomes = (corpus.db.prepare('SELECT COUNT(*) c FROM run_outcomes').get() as { c: number }).c;
    const scheds = (corpus.db.prepare('SELECT COUNT(*) c FROM schedules WHERE enabled=1').get() as { c: number }).c;
    const bytes = (corpus.db.prepare('SELECT SUM(LENGTH(report_json) + LENGTH(jobspec_json)) b FROM runs').get() as { b: number }).b;

    console.info(
      `[bench] corpus: ${runs} runs | ${docs} FTS docs | ${outcomes} decided | ${scheds} enabled schedules | ` +
        `${(bytes / 1_048_576).toFixed(1)}MB of jobspec+report JSON`,
    );

    expect(runs).toBe(RUN_COUNT);
    expect(docs).toBe(RUN_COUNT + TASK_COUNT);
    expect(outcomes).toBeGreaterThan(1_200);
    expect(scheds).toBe(RRULE_SCHEDULES + 40);
    // Both grouping branches must be populated, or F10/F11 are measured on half
    // the work they really do.
    const viaOutcome = (corpus.db.prepare('SELECT COUNT(*) c FROM run_outcomes WHERE profile_id IS NOT NULL').get() as { c: number }).c;
    const unassigned = (
      corpus.db.prepare(`SELECT COUNT(*) c FROM runs WHERE json_extract(jobspec_json, '$.profile.id') IS NULL`).get() as { c: number }
    ).c;
    expect(viaOutcome).toBeGreaterThan(500);
    expect(unassigned).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// T-113 — FTS over a 5,000-run corpus. Claim: < 100ms.
// ---------------------------------------------------------------------------
describe('T-113 — full-text search over a 5,000-run corpus (<100ms)', () => {
  /** Verbatim from api.ts:1205 (the no-kind-filter branch). */
  const SEARCH_SQL =
    `SELECT kind, ref_id, title, snippet(search_idx, 3, '[', ']', '…', 12) AS snip ` +
    `FROM search_idx WHERE search_idx MATCH ? ORDER BY rank LIMIT 50`;
  /** Verbatim from api.ts:1206 (the kind-filtered branch the inbox uses). */
  const SEARCH_SQL_KIND =
    `SELECT kind, ref_id, title, snippet(search_idx, 3, '[', ']', '…', 12) AS snip ` +
    `FROM search_idx WHERE search_idx MATCH ? AND kind=? ORDER BY rank LIMIT 50`;

  /** Exactly how the route turns user input into an FTS query (api.ts:1203). */
  function ftsQuery(q: string): string {
    return q.trim().split(/\s+/).map((w) => `${w}*`).join(' ');
  }

  it('a COMMON prefix term (thousands of matches) stays under 100ms', () => {
    const stmt = corpus.db.prepare(SEARCH_SQL);
    const q = ftsQuery('repo');

    const matched = (
      corpus.db.prepare('SELECT COUNT(*) c FROM search_idx WHERE search_idx MATCH ?').get(q) as { c: number }
    ).c;
    console.info(`[bench] FTS common term "repo*" matches ${matched} of ${RUN_COUNT + TASK_COUNT} documents`);
    // The whole point of "common": FTS5 must bm25-rank thousands of rows
    // before LIMIT 50 can cut. A cheap query here would be a rigged benchmark.
    expect(matched).toBeGreaterThan(4_000);

    const st = bench('T-113 /search common term "repo*" (5k corpus)', () => {
      const rows = stmt.all(q);
      expect(rows.length).toBe(50);
    });

    assertLatency('T-113 /search common term (median, claim: 100ms)', st.median, 100);
    assertLatency('T-113 /search common term (p95, headroom: 300ms)', st.p95, 300);
  });

  it('a RARE prefix term stays under 100ms', () => {
    const stmt = corpus.db.prepare(SEARCH_SQL);
    const q = ftsQuery('cranberry');
    const rows = stmt.all(q);
    expect(rows.length).toBeGreaterThan(0);

    const st = bench('T-113 /search rare term "cranberry*" (5k corpus)', () => stmt.all(q));
    assertLatency('T-113 /search rare term (median, claim: 100ms)', st.median, 100);
    assertLatency('T-113 /search rare term (p95, headroom: 300ms)', st.p95, 300);
  });

  it('a MULTI-TERM query with the kind=run filter stays under 100ms', () => {
    const stmt = corpus.db.prepare(SEARCH_SQL_KIND);
    const q = ftsQuery('migration schema');
    const st = bench('T-113 /search "migration* schema*" kind=run (5k corpus)', () => stmt.all(q, 'run'));
    assertLatency('T-113 /search multi-term + kind filter (median, claim: 100ms)', st.median, 100);
    assertLatency('T-113 /search multi-term + kind filter (p95, headroom: 300ms)', st.p95, 300);
  });

  it('through the real HTTP route, end to end', async () => {
    const st = await benchAsync('T-113 GET /search?q=repo end-to-end (5k corpus)', async () => {
      const res = await corpus.app.inject({
        method: 'GET',
        url: '/search?q=repo',
        headers: { authorization: `Bearer ${corpus.token}` },
      });
      expect(res.statusCode).toBe(200);
    });
    assertLatency('T-113 GET /search end-to-end (median, claim: 100ms)', st.median, 100);
    assertLatency('T-113 GET /search end-to-end (p95, headroom: 300ms)', st.p95, 300);
  });

  it('index-on-finalize (indexRun) cost on a full 5k index — the WRITE path', () => {
    // repo.ts:302 deletes by `kind='run' AND ref_id=?`, and `ref_id` is
    // UNINDEXED in the FTS5 declaration (0001_init.sql:120-125), so the DELETE
    // cannot seek — it walks the index. This measures what one finalize costs
    // against a full 5k corpus, since that walk is paid on EVERY completed run.
    // Measured 0.73ms median: linear in corpus size but small in absolute
    // terms at 5k. Reported, not flagged.
    let n = 0;
    const st = bench(
      'T-113/write indexRun() one call against a full 5k index',
      () => {
        n += 1;
        indexRun(corpus.db, `bench-run-0000${n % 10}`, 'Bench task 0', `reindexed body ${n} repository summary`);
      },
      15,
      2,
    );
    // No claimed bound; generous ceiling so a real regression trips.
    assertLatency('T-113/write indexRun() (median, no claimed bound)', st.median, 2_000);
  });
});

// ---------------------------------------------------------------------------
// T-307 — calendar windowing over 5,000 historical runs. NFR-3: < 500ms.
// ---------------------------------------------------------------------------
describe('T-307 — calendar windowing over 5,000 historical runs (NFR-3 <500ms)', () => {
  function calendarUrl(from: number, to: number): string {
    return `/calendar?from=${from}&to=${to}`;
  }

  it('S-64 YEAR view — the window that returns every one of the 5,000 runs', async () => {
    const from = ANCHOR - 365 * DAY_MS;
    const to = ANCHOR + 31 * DAY_MS;

    const probe = await corpus.app.inject({
      method: 'GET',
      url: calendarUrl(from, to),
      headers: { authorization: `Bearer ${corpus.token}` },
    });
    expect(probe.statusCode).toBe(200);
    const body = probe.json() as { runs: Array<Record<string, unknown>>; bookings: unknown[] };
    console.info(
      `[bench] calendar year view returns ${body.runs.length} runs + ${body.bookings.length} bookings, ` +
        `payload ${(Buffer.byteLength(probe.payload) / 1_048_576).toFixed(2)}MB`,
    );
    expect(body.runs.length).toBe(RUN_COUNT); // the whole history, per S-64
    expect(body.bookings.length).toBeGreaterThan(100); // the RRULE expansion is really running

    // The windowed projection (NFR-3): the frozen snapshot name is still
    // carried, the rest of the jobspec is not. Guarding both directions —
    // dropping task_name would silently blank every calendar chip, and
    // re-adding jobspec_json would silently restore the 10MB payload.
    expect(body.runs[0].task_name).toMatch(/^Bench task /);
    expect(body.runs[0]).not.toHaveProperty('jobspec_json');

    const st = await benchAsync('T-307 GET /calendar year view (5,000 runs + bookings)', async () => {
      const res = await corpus.app.inject({
        method: 'GET',
        url: calendarUrl(from, to),
        headers: { authorization: `Bearer ${corpus.token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    // MEASURED, and the breakdown matters more than the total:
    //   353.55ms median / 10.16MB payload  — before the task_name projection
    //   358.69ms median /  1.15MB payload  — after it
    // The projection is a payload win (8.8x), NOT a latency win. Latency is
    // ~320ms of RRULE expansion: recurrence.ts:70-72 anchors a DTSTART-less
    // rule at 19700101, so RRule.between() replays every occurrence since 1970
    // before it reaches the window — 25.76ms for one FREQ=DAILY rule, 6.18ms
    // for one FREQ=WEEKLY, against 0.11ms for the same daily rule anchored near
    // the window. This corpus holds 10 daily + 10 weekly => ~319ms. The runs
    // SQL is 12.43ms of the total (measured separately below).
    // The bound holds on this machine (Apple M4). T-307's acceptance surface is
    // "a base M1 Air" (plan/05-execution-plan.md:100), which was NOT measured.
    assertLatency('T-307 /calendar year view (median, NFR-3: 500ms)', st.median, 500);
    assertLatency('T-307 /calendar year view (p95, headroom: 1500ms)', st.p95, 1_500);
  });

  it("the route's DEFAULT window (62d back / 31d forward) stays well under NFR-3", async () => {
    // Fewer samples than the year view on purpose: this is the secondary case
    // and each sample costs ~325ms of wall clock in a suite that must stay fast.
    const st = await benchAsync(
      'T-307 GET /calendar default window',
      async () => {
        const res = await corpus.app.inject({
          method: 'GET',
          url: '/calendar',
          headers: { authorization: `Bearer ${corpus.token}` },
        });
        expect(res.statusCode).toBe(200);
      },
      5,
      1,
    );
    // Barely cheaper than the year view (325.78ms vs 358.69ms) even though it
    // returns ~1/6th the rows: more evidence that the cost is the per-schedule
    // RRULE replay from 1970, not the window size.
    assertLatency('T-307 /calendar default window (median, NFR-3: 500ms)', st.median, 500);
    assertLatency('T-307 /calendar default window (p95, headroom: 1500ms)', st.p95, 1_500);
  });

  it('the runs SQL alone (no serialization, no RRULE expansion) over the full history', () => {
    // Isolates the storage half of the handler from the JSON half, so the
    // handback can say which one dominates instead of guessing.
    const from = ANCHOR - 365 * DAY_MS;
    const to = ANCHOR + 31 * DAY_MS;
    const stmt = corpus.db.prepare(
      `SELECT id, task_id, state, outcome_reason, scheduled_for, started_at, ended_at, cost_usd, turns,
              json_extract(jobspec_json, '$.taskName') AS task_name
       FROM runs
       WHERE (scheduled_for BETWEEN ? AND ?)
          OR (started_at BETWEEN ? AND ?)
          OR (ended_at BETWEEN ? AND ?)
       ORDER BY COALESCE(scheduled_for, started_at, ended_at) ASC`,
    );

    const plan = corpus.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM runs
         WHERE (scheduled_for BETWEEN ? AND ?)
            OR (started_at BETWEEN ? AND ?)
            OR (ended_at BETWEEN ? AND ?)
         ORDER BY COALESCE(scheduled_for, started_at, ended_at) ASC`,
      )
      .all(from, to, from, to, from, to) as Array<{ detail: string }>;
    console.info(`[bench] calendar runs-query plan: ${plan.map((p) => p.detail).join(' / ')}`);

    const st = bench('T-307 calendar runs SQL only (year window, 5,000 rows)', () => {
      const rows = stmt.all(from, to, from, to, from, to) as unknown[];
      expect(rows.length).toBe(RUN_COUNT);
    });
    assertLatency('T-307 calendar runs SQL only (median, NFR-3: 500ms)', st.median, 500);
  });
});

// ---------------------------------------------------------------------------
// F10 / F11 — the JSON1 grouping aggregates. No index is possible on
// json_extract(...), so these are full scans by construction.
// ---------------------------------------------------------------------------
describe('F10/F11 — workforce aggregates over a 5,000-run corpus (JSON1 grouping, unindexable)', () => {
  const from = ANCHOR - 365 * DAY_MS;
  const to = ANCHOR + DAY_MS;

  it('F10 timesheet() over the full 365-day window', () => {
    const sheet = timesheet(corpus.db, { fromMs: from, toMs: to });
    console.info(`[bench] timesheet groups: ${sheet.rows.length} (runs counted: ${sheet.rows.reduce((n, r) => n + r.runs, 0)})`);
    expect(sheet.rows.reduce((n, r) => n + r.runs, 0)).toBe(RUN_COUNT);
    // Both branches of the grouping key produced a group.
    expect(sheet.rows.some((r) => r.profileId === null)).toBe(true);
    expect(sheet.rows.some((r) => r.profileId !== null)).toBe(true);

    const st = bench('F10 timesheet() 5k runs / 365d window', () => timesheet(corpus.db, { fromMs: from, toMs: to }));
    assertLatency('F10 timesheet() full window (median, no claimed bound)', st.median, 2_000);
  });

  it('F10 timesheet() filtered to one profile (the filter is in JS, not SQL)', () => {
    const st = bench('F10 timesheet(profileId) 5k runs / 365d window', () =>
      timesheet(corpus.db, { fromMs: from, toMs: to, profileId: corpus.profileIds[0] }),
    );
    assertLatency('F10 timesheet(profileId) (median, no claimed bound)', st.median, 2_000);
  });

  it('F11 scorecard() for one profile — two windowed scans (current + previous)', () => {
    const card = scorecard(corpus.db, corpus.profileIds[0], { fromMs: from, toMs: to });
    expect(card.runs).toBeGreaterThan(500);
    const st = bench('F11 scorecard(one profile) 5k runs / 365d window', () =>
      scorecard(corpus.db, corpus.profileIds[0], { fromMs: from, toMs: to }),
    );
    assertLatency('F11 scorecard(one profile) (median, no claimed bound)', st.median, 2_000);
  });

  it('F11 scorecards() for EVERY group — 1 + 2xN windowed scans', () => {
    const cards = scorecards(corpus.db, { fromMs: from, toMs: to });
    console.info(`[bench] scorecards() groups: ${cards.length} => ${1 + 2 * cards.length} full scans of runs`);
    expect(cards.length).toBe(PROFILE_COUNT + 1); // 6 profiles + Unassigned
    const st = bench(
      'F11 scorecards(all groups) 5k runs / 365d window',
      () => scorecards(corpus.db, { fromMs: from, toMs: to }),
      15,
      2,
    );
    assertLatency('F11 scorecards(all groups) (median, no claimed bound)', st.median, 2_000);
  });
});

// ---------------------------------------------------------------------------
// S-9 — the 500-task / 50-due tick fixture, replicated on its own DB so
// scheduler.test.ts:317 stays untouched. Measured with the workforce features
// OFF (their shipped default) and with F3 office-hours ON, since
// shiftForApproval is the only workforce hook inside the tick path.
// ---------------------------------------------------------------------------
describe('S-9 — tick loop at scale, with the twelve workforce features present', () => {
  function freshSchedulerDb(): { db: DB; dir: string; clock: FakeClock; enqueued: unknown[]; scheduler: Scheduler } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-bench-tick-'));
    const { db } = openDatabase(dir);
    createMigrator(db, MIGRATIONS).migrate();
    const clock = new FakeClock(ANCHOR + 12 * 3_600_000);
    const enqueued: unknown[] = [];
    const scheduler = new Scheduler({
      db,
      clock,
      enqueueRun: (spec) => enqueued.push(spec),
      notify: () => {},
    });
    return { db, dir, clock, enqueued, scheduler };
  }

  /** 450 idle + 50 due, but every schedule RECURRING — the production shape. */
  function seed500Rrule(db: DB, clock: FakeClock): void {
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, 'do things', ?, ?)`,
    );
    const insertSched = db.prepare(
      `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
       VALUES (?, ?, 'rrule', 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', NULL, NULL, 'UTC', ?, 1)`,
    );
    const now = clock.now();
    db.transaction(() => {
      for (let i = 0; i < 450; i++) {
        insertTask.run(`idle-${i}`, `idle-${i}`, now, now);
        insertSched.run(`s-idle-${i}`, `idle-${i}`, now + 3_600_000);
      }
      for (let i = 0; i < 50; i++) {
        insertTask.run(`due-${i}`, `due-${i}`, now, now);
        insertSched.run(`s-due-${i}`, `due-${i}`, now - i - 1);
      }
    })();
  }

  /** Same shape as scheduler.test.ts:317-325 — 450 idle + 50 due. */
  function seed500(db: DB, clock: FakeClock, profileId: string | null): void {
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, name, prompt, profile_id, created_at, updated_at) VALUES (?, ?, 'do things', ?, ?, ?)`,
    );
    const insertSched = db.prepare(
      `INSERT INTO schedules (id, task_id, kind, rrule, cron, run_at, tz, next_fire, enabled)
       VALUES (?, ?, 'once', NULL, NULL, ?, 'UTC', ?, 1)`,
    );
    const now = clock.now();
    db.transaction(() => {
      if (profileId) {
        db.prepare(
          `INSERT INTO profiles (id, slug, name, may_require_approval, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
        ).run(profileId, profileId, 'Approval-needing agent', now, now);
      }
      for (let i = 0; i < 450; i++) {
        insertTask.run(`idle-${i}`, `idle-${i}`, profileId, now, now);
        insertSched.run(`s-idle-${i}`, `idle-${i}`, now + 3_600_000, now + 3_600_000);
      }
      for (let i = 0; i < 50; i++) {
        insertTask.run(`due-${i}`, `due-${i}`, profileId, now, now);
        insertSched.run(`s-due-${i}`, `due-${i}`, now - i - 1, now - i - 1);
      }
    })();
  }

  it('500 tasks / 50 due: one tick stays inside the fixture bound', async () => {
    const h = freshSchedulerDb();
    try {
      seed500(h.db, h.clock, null);
      const t0 = performance.now();
      await h.scheduler.tick();
      const ms = performance.now() - t0;
      console.info(`[bench] S-9 tick (500 tasks, 50 due, workforce features at shipped defaults): ${ms.toFixed(2)}ms`);
      expect(h.enqueued.length).toBe(50);
      assertLatency('S-9 tick, 500 tasks / 50 due (same 5s bound scheduler.test.ts:328 asserts)', ms, 5_000);
    } finally {
      h.scheduler.stop();
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('500 tasks / 50 due with F3 office-hours ON — the only workforce hook inside the tick', async () => {
    const h = freshSchedulerDb();
    try {
      seed500(h.db, h.clock, 'bench-oh-profile');
      h.db.prepare('UPDATE workforce_prefs SET office_hours_enabled = 1 WHERE id = 1').run();
      // One window that is open right now, so shiftForApproval walks the full
      // path (prefs -> flagged join -> window load -> containment) and returns
      // null via inOfficeHours rather than short-circuiting at the prefs read.
      const now = h.clock.now();
      h.db
        .prepare(
          `INSERT INTO office_hours (id, label, dow, start_min, end_min, tz, enabled, created_at, updated_at)
           VALUES ('oh-1', 'all day', ?, 0, 1440, 'UTC', 1, ?, ?)`,
        )
        .run(new Date(now).getUTCDay(), now, now);

      const t0 = performance.now();
      await h.scheduler.tick();
      const ms = performance.now() - t0;
      console.info(`[bench] S-9 tick (500 tasks, 50 due, F3 office-hours ENABLED): ${ms.toFixed(2)}ms`);
      expect(h.enqueued.length).toBe(50); // the window is open: nothing is deferred
      assertLatency('S-9 tick, 500 tasks / 50 due, F3 ON (same 5s bound scheduler.test.ts:328 asserts)', ms, 5_000);
    } finally {
      h.scheduler.stop();
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('500 tasks / 50 due, all RECURRING — the shape the fixture has never covered', async () => {
    // scheduler.test.ts:317-325 seeds only `kind:'once'` schedules, which
    // short-circuit occurrencesBetween (recurrence.ts:60). Production schedules
    // recur, and every fire re-materializes next_fire through
    // nextOccurrenceAfter -> occurrencesBetween over a 732-day horizon.
    //
    // PRE-EXISTING COST, NOT A WORKFORCE REGRESSION: recurrence.ts is T-103
    // code and none of the twelve workforce features touch it. Measured in
    // isolation, one nextOccurrenceAfter call costs 26.89ms for FREQ=DAILY and
    // 4.65ms for FREQ=WEEKLY, against 0.10ms for the equivalent cron — because
    // a DTSTART-less rule is anchored at 19700101 (recurrence.ts:70-72) and
    // RRule.between() replays every occurrence since then. 50 daily fires
    // therefore cost ~1.3s of a tick that has a 30s budget.
    const h = freshSchedulerDb();
    try {
      seed500Rrule(h.db, h.clock);
      const t0 = performance.now();
      await h.scheduler.tick();
      const ms = performance.now() - t0;
      console.info(`[bench] S-9 tick (500 tasks, 50 due, all FREQ=DAILY rrule): ${ms.toFixed(2)}ms`);
      expect(h.enqueued.length).toBe(50);
      assertLatency('S-9 tick, 500 tasks / 50 due, all recurring (same 5s bound scheduler.test.ts:328 asserts)', ms, 5_000);
    } finally {
      h.scheduler.stop();
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
