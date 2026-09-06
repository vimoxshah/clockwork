/**
 * GET /analytics contract tests (ADR-029).
 *
 * The regression these exist for: the endpoint 500'd
 * `{"message":"Invalid time value"}` for as long as ANY run was queued,
 * running or waiting for approval — i.e. the normal state of this product —
 * because the SELECT list omitted `scheduled_for` while the row bucketing read
 * it. The whole Analytics ▸ Overview tab rendered a bare 'Internal Server
 * Error' band.
 *
 * Beyond "does not throw", these pin down HOW an unfinished run is represented
 * in an analytics window: it is a real run in the window (counted, its spend so
 * far counted, bucketed on the day it was scheduled for) but it is never
 * counted as a finished one — not completed, not failed, not a duration
 * sample, and not part of any rate's denominator.
 *
 * Harness is `workforce-api.test.ts`'s: temp dir, real RunManager pointed at a
 * nonexistent runner child (no run ever starts), buildServer, app.inject.
 * Runs are created with the exported `enqueueRunNow` rather than
 * POST /tasks/:id/run-now so no child spawn is attempted, then moved into the
 * state under test with a direct UPDATE — the FSM is not what is on trial here.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer, enqueueRunNow } from '../src/api.js';
import { TaskRepo } from '../src/repo.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

let db: DB;
let dir: string;
let app: FastifyInstance;
let token: string;
let tasks: TaskRepo;

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

const DAY = 86_400_000;

interface AnalyticsBody {
  range: { from: number; to: number; days: number };
  totals: {
    runs: number;
    completed: number;
    failed: number;
    inFlight: number;
    successRate: number;
    costUsd: number;
    turns: number;
    avgCostPerRun: number;
  };
  byTask: Array<{
    taskId: string;
    name: string;
    runs: number;
    completed: number;
    failed: number;
    inFlight: number;
    costUsd: number;
    successRate: number;
    avgDurationMs: number;
  }>;
  byProvider: Array<{ engine: string; runs: number; completed: number; failed: number; inFlight: number; successRate: number; costUsd: number }>;
  daily: Array<{ day: string; runs: number; costUsd: number }>;
  suggestions: Array<{ taskName: string; kind: string; message: string }>;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-analytics-'));
  db = openDatabase(dir).db;
  createMigrator(db, MIGRATIONS).migrate();
  tasks = new TaskRepo(db);

  const rm = new RunManager({
    db,
    clock: new FakeClock(Date.now()),
    dataDir: dir,
    runnerChildModule: '/nonexistent/runner-child.js', // not exercised in contract tests
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock: new FakeClock(Date.now()), enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir: dir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM runs');
});

function auth(json: Record<string, unknown>): Record<string, unknown> {
  return { ...json, headers: { authorization: `Bearer ${token}` } };
}

/** A queued task with no schedule, created through the real route. */
async function makeTask(name: string): Promise<string> {
  const res = await app.inject(
    auth({
      method: 'POST',
      url: '/tasks',
      payload: { name, prompt: `Prompt for ${name}.`, schedule: { kind: 'queue', tz: 'UTC' } },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** A `runs` row in state 'queued' (scheduled_for = now, ended_at NULL) — no child is ever spawned. */
function makeRun(taskId: string, scheduledFor = Date.now()): string {
  const runId = enqueueRunNow(db, tasks.get(taskId)!);
  db.prepare('UPDATE runs SET scheduled_for=? WHERE id=?').run(scheduledFor, runId);
  return runId;
}

/** Moves a run into a non-terminal state the way the manager would, minus the FSM. */
function setInFlight(runId: string, state: 'queued' | 'running' | 'waiting_approval', patch: Record<string, unknown> = {}): void {
  db.prepare('UPDATE runs SET state=?, started_at=?, cost_usd=?, turns=? WHERE id=?').run(
    state,
    patch.startedAt === undefined ? null : (patch.startedAt as number),
    (patch.costUsd as number) ?? 0,
    (patch.turns as number) ?? 0,
    runId,
  );
}

/** Moves a run to a terminal state with a real end time. */
function finish(
  runId: string,
  opts: { state?: string; startedAt?: number | null; endedAt: number; costUsd?: number; turns?: number },
): void {
  db.prepare('UPDATE runs SET state=?, started_at=?, ended_at=?, cost_usd=?, turns=? WHERE id=?').run(
    opts.state ?? 'completed',
    opts.startedAt === undefined ? opts.endedAt - 1000 : opts.startedAt,
    opts.endedAt,
    opts.costUsd ?? 0,
    opts.turns ?? 0,
    runId,
  );
}

async function analytics(days = 30): Promise<{ statusCode: number; body: string; json: () => AnalyticsBody }> {
  const res = await app.inject(auth({ method: 'GET', url: `/analytics?days=${days}` }));
  return { statusCode: res.statusCode, body: res.body, json: () => res.json() as AnalyticsBody };
}

// ---------------------------------------------------------------------------
// The blocker: an unfinished run must not take the endpoint down.
// ---------------------------------------------------------------------------
describe('GET /analytics with an unfinished run in the window', () => {
  it.each([['queued'], ['running'], ['waiting_approval']] as const)(
    'answers 200 while a %s run is present',
    async (state) => {
      const taskId = await makeTask(`analytics ${state}`);
      const runId = makeRun(taskId);
      setInFlight(runId, state, { startedAt: state === 'queued' ? null : Date.now() });

      const res = await analytics();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().totals.runs).toBe(1);
      expect(res.json().totals.inFlight).toBe(1);
    },
  );

  it('buckets an unfinished run on the day it was scheduled for, not on NaN', async () => {
    const taskId = await makeTask('analytics bucketing');
    const scheduledFor = Date.now() - 3 * DAY;
    setInFlight(makeRun(taskId, scheduledFor), 'running', { startedAt: scheduledFor, costUsd: 0.25 });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    const day = new Date(scheduledFor).toISOString().slice(0, 10);
    expect(res.json().daily).toEqual([{ day, runs: 1, costUsd: 0.25 }]);
  });
});

// ---------------------------------------------------------------------------
// How an unfinished run is represented once the endpoint answers.
// ---------------------------------------------------------------------------
describe('GET /analytics representation of an unfinished run', () => {
  it('counts it as a run and counts its spend so far, but never as completed or failed', async () => {
    const taskId = await makeTask('analytics mixed');
    finish(makeRun(taskId), { endedAt: Date.now(), costUsd: 1, turns: 10 });
    setInFlight(makeRun(taskId), 'running', { startedAt: Date.now(), costUsd: 0.5, turns: 4 });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json().totals;
    expect(t.runs).toBe(2);
    expect(t.completed).toBe(1);
    expect(t.failed).toBe(0);
    expect(t.inFlight).toBe(1);
    // money already spent is money already spent, even mid-run
    expect(t.costUsd).toBe(1.5);
    expect(t.turns).toBe(14);
  });

  it('keeps the success rate over FINISHED runs only — one run still going is not a failure', async () => {
    const taskId = await makeTask('analytics rate');
    finish(makeRun(taskId), { endedAt: Date.now(), costUsd: 1 });
    setInFlight(makeRun(taskId), 'waiting_approval', { startedAt: Date.now() });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.successRate).toBe(100);
    expect(res.json().byTask[0]!.successRate).toBe(100);
    expect(res.json().byProvider[0]!.successRate).toBe(100);
  });

  it('still divides the success rate by every finished run, failures included', async () => {
    const taskId = await makeTask('analytics rate with a failure');
    finish(makeRun(taskId), { endedAt: Date.now() });
    finish(makeRun(taskId), { state: 'failed', endedAt: Date.now() });
    setInFlight(makeRun(taskId), 'queued');

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.successRate).toBe(50);
    expect(res.json().totals.inFlight).toBe(1);
  });

  it('reports 0% rather than dividing by zero when nothing has finished yet', async () => {
    const taskId = await makeTask('analytics nothing finished');
    setInFlight(makeRun(taskId), 'running', { startedAt: Date.now() });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.successRate).toBe(0);
    expect(res.json().byTask[0]!.successRate).toBe(0);
  });

  it('excludes it from the average duration — a run with no end time has no duration', async () => {
    const taskId = await makeTask('analytics duration');
    const now = Date.now();
    finish(makeRun(taskId), { startedAt: now - 1000, endedAt: now });
    setInFlight(makeRun(taskId), 'running', { startedAt: now });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    // one 1000 ms sample — NOT (1000 + 0) / 2
    expect(res.json().byTask[0]!.avgDurationMs).toBe(1000);
  });

  it('reports a 0 ms average when no run in the window was ever timed', async () => {
    const taskId = await makeTask('analytics untimed');
    finish(makeRun(taskId), { state: 'missed', startedAt: null, endedAt: Date.now() });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().byTask[0]!.runs).toBe(1);
    expect(res.json().byTask[0]!.avgDurationMs).toBe(0);
  });

  it('does not let an unfinished run pose as a failure in the prompt-scoping suggestion', async () => {
    const taskId = await makeTask('analytics turn hungry');
    // 3 completed runs, no failures, >40 turns each: 'has failures' is false.
    for (let i = 0; i < 3; i++) finish(makeRun(taskId), { endedAt: Date.now(), turns: 50, costUsd: 0.01 });
    setInFlight(makeRun(taskId), 'running', { startedAt: Date.now(), turns: 50 });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().suggestions.filter((s) => s.kind === 'prompt_scoping')).toEqual([]);
  });

  it('still raises the prompt-scoping suggestion for a task that really does fail', async () => {
    const taskId = await makeTask('analytics turn hungry and failing');
    for (let i = 0; i < 3; i++) finish(makeRun(taskId), { endedAt: Date.now(), turns: 50, costUsd: 0.01 });
    finish(makeRun(taskId), { state: 'failed', endedAt: Date.now(), turns: 50 });

    const res = await analytics();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().suggestions.map((s) => s.kind)).toContain('prompt_scoping');
  });
});
