/**
 * The other half of the digest cross-check (T4-9).
 *
 * `packages/ui/test/morning-digest.test.tsx` asserts that the Inbox digest's
 * `digestOf` produces `EXPECTED_LONG_WEEKEND` over the seeded corpus. This
 * file replays the SAME rows into a real migrated database and asserts that
 * `GET /analytics` — the daemon's own arithmetic, over the identical window —
 * produces them too. Neither suite can drift without the other going red, so
 * "the digest counts the way analytics counts" is a fact about two
 * implementations rather than a promise in a comment.
 *
 * The window lines up by construction: `LAST_READ_LONG_WEEKEND` is exactly
 * five days before `NOW`, and `GET /analytics?days=5&to=NOW` spans
 * `[NOW - 5d, NOW]`. The digest's lower bound is exclusive and analytics' is
 * inclusive; no run in the corpus sits on the boundary, which the first test
 * here pins so a future corpus edit cannot silently make the two windows
 * different.
 *
 * Harness is `analytics.test.ts`'s: temp dir, real RunManager pointed at a
 * runner child that is never spawned, `buildServer`, `app.inject`. Rows go in
 * with a direct INSERT because they are already the daemon's own output —
 * re-running them through the FSM would prove nothing this file is about.
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
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import {
  EXPECTED_LONG_WEEKEND,
  LAST_READ_LONG_WEEKEND,
  NOW,
  WEEK_OF_RUNS,
} from '../../ui/test/helpers/overnight-corpus.js';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const DAY = 86_400_000;

interface AnalyticsTotals {
  runs: number;
  completed: number;
  failed: number;
  inFlight: number;
  successRate: number;
  costUsd: number;
  turns: number;
  avgCostPerRun: number;
}

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-digest-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();

  const rm = new RunManager({
    db,
    clock: new FakeClock(NOW),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // never spawned here
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock: new FakeClock(NOW), enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();

  // `runs.task_id` has a foreign key and `foreign_keys` is ON (db.ts:19), so
  // the four tasks the corpus refers to have to exist first.
  const insertTask = db.prepare(
    'INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const seen = new Set<string>();
  for (const r of WEEK_OF_RUNS) {
    if (seen.has(r.task_id)) continue;
    seen.add(r.task_id);
    insertTask.run(r.task_id, r.task_id, 'seeded', NOW, NOW);
  }

  const insertRun = db.prepare(
    `INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at,
                       worktree_path, branch, cost_usd, turns, started_at, ended_at,
                       scheduled_for, outcome_reason, report_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of WEEK_OF_RUNS) {
    insertRun.run(
      r.id,
      r.task_id,
      r.scheduled_for,
      r.jobspec_json,
      r.state,
      r.ended_at ?? r.started_at ?? r.scheduled_for,
      r.worktree_path,
      r.branch,
      r.cost_usd,
      r.turns,
      r.started_at,
      r.ended_at,
      r.scheduled_for,
      r.outcome_reason,
      r.report_json,
    );
  }
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function analyticsTotals(): Promise<{ statusCode: number; body: string; totals: AnalyticsTotals }> {
  const res = await app.inject({
    method: 'GET',
    url: `/analytics?days=5&to=${NOW}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    totals: (res.json() as { totals: AnalyticsTotals }).totals,
  };
}

describe('the digest and GET /analytics count the same window the same way', () => {
  it('spans the same window — five days, and nothing sitting on the boundary', () => {
    expect(NOW - LAST_READ_LONG_WEEKEND).toBe(5 * DAY);
    const onEdge = WEEK_OF_RUNS.filter((r) => {
      const at = r.ended_at ?? r.scheduled_for;
      return at === LAST_READ_LONG_WEEKEND || at === NOW;
    });
    expect(
      onEdge.map((r) => r.id),
      'a run exactly on the boundary would land in one window and not the other',
    ).toEqual([]);
  });

  it('loaded the corpus the UI test counts, in full', () => {
    const n = db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number };
    expect(n.c).toBe(WEEK_OF_RUNS.length);
  });

  it('reports the digest’s run, completion and failure counts', async () => {
    const { statusCode, body, totals } = await analyticsTotals();
    expect(statusCode, body).toBe(200);
    expect(totals.runs).toBe(EXPECTED_LONG_WEEKEND.runs);
    expect(totals.completed).toBe(EXPECTED_LONG_WEEKEND.completed);
    expect(totals.failed).toBe(EXPECTED_LONG_WEEKEND.failed);
  });

  it('reports the digest’s spend and success rate', async () => {
    const { totals } = await analyticsTotals();
    expect(totals.costUsd).toBe(EXPECTED_LONG_WEEKEND.costUsd);
    expect(totals.successRate).toBe(EXPECTED_LONG_WEEKEND.successRate);
  });

  it('reports the run still in flight separately, and out of every rate', async () => {
    const { totals } = await analyticsTotals();
    expect(totals.inFlight).toBe(EXPECTED_LONG_WEEKEND.inFlight);
    // The four rules the digest matches, restated against the real route:
    // counted in `runs`, never in `completed` or `failed`, and the rate's
    // denominator is `runs - inFlight`.
    const finished = totals.runs - totals.inFlight;
    expect(finished).toBe(EXPECTED_LONG_WEEKEND.finished);
    expect(Math.round((totals.completed / finished) * 100)).toBe(totals.successRate);
    expect(totals.completed + totals.failed).toBeLessThan(totals.runs);
  });

  it('counts the in-flight run’s spend so far, as the digest does', async () => {
    const inFlight = WEEK_OF_RUNS.filter((r) => r.ended_at === null && r.state === 'running');
    expect(inFlight, 'the corpus no longer has a run in flight').toHaveLength(1);
    const spentSoFar = inFlight[0]!.cost_usd;
    expect(spentSoFar).toBeGreaterThan(0);

    const { totals } = await analyticsTotals();
    db.prepare('DELETE FROM runs WHERE id=?').run(inFlight[0]!.id);
    try {
      const after = await analyticsTotals();
      expect(Math.round((totals.costUsd - after.totals.costUsd) * 10_000) / 10_000).toBe(spentSoFar);
      expect(after.totals.successRate).toBe(totals.successRate);
    } finally {
      const r = inFlight[0]!;
      db.prepare(
        `INSERT INTO runs (id, task_id, occurrence_at, jobspec_json, state, state_changed_at,
                           worktree_path, branch, cost_usd, turns, started_at, ended_at,
                           scheduled_for, outcome_reason, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id, r.task_id, r.scheduled_for, r.jobspec_json, r.state, r.started_at ?? r.scheduled_for,
        r.worktree_path, r.branch, r.cost_usd, r.turns, r.started_at, r.ended_at,
        r.scheduled_for, r.outcome_reason, r.report_json,
      );
    }
  });

  it('does not call the budget bust a failure, which is why the digest lists it separately', async () => {
    const busts = WEEK_OF_RUNS.filter((r) => {
      const at = r.ended_at ?? r.scheduled_for;
      return r.state === 'budget_exceeded' && at !== null && at > LAST_READ_LONG_WEEKEND && at <= NOW;
    });
    expect(busts, 'the corpus no longer has a budget bust in this window').toHaveLength(1);

    const { totals } = await analyticsTotals();
    // Terminal, so it is in the rate's denominator; not `failed`, so the
    // digest's "did not finish cleanly" list is one longer than this number.
    expect(totals.failed).toBe(EXPECTED_LONG_WEEKEND.failed);
    expect(totals.runs - totals.inFlight).toBe(totals.completed + totals.failed + busts.length);
  });
});
