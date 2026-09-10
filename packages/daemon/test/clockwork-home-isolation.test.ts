/**
 * T1-15 — CLOCKWORK_HOME must isolate worktrees and scratch, not just the
 * database and logs.
 *
 * main.ts:415 resolves the daemon's data dir as
 * `process.env.CLOCKWORK_HOME ?? \`${process.env.HOME}/.clockwork\``. Two
 * call sites in api.ts (`enqueueRunNow`/`jobSpecForTask`, the run-now path)
 * and two in scheduler.ts (`buildJobSpec`, the scheduled-fire path) used to
 * re-derive `worktreePath`/`scratchPath` straight from `process.env.HOME`,
 * ignoring CLOCKWORK_HOME entirely. A second daemon started with
 * CLOCKWORK_HOME set for isolation — which is how tests, CI and anyone
 * debugging two versions side by side run it — therefore still wrote real
 * directories into the PRIMARY install's `~/.clockwork/worktrees` and
 * `~/.clockwork/scratch`. Confirmed for real: an agent's mock runs, booked
 * under an isolated CLOCKWORK_HOME specifically to avoid the running daemon,
 * still left directories in the real `~/.clockwork/scratch/`.
 *
 * This suite never moves HOME — only CLOCKWORK_HOME — because pointing HOME
 * at a temp dir would make the OLD hardcoded formula land in the temp dir
 * too, hiding exactly the bug under test (see pause.test.ts's `realHome`
 * workaround for a test that deliberately does the opposite, for a
 * different reason). And nothing here calls `pump()`: a run's worktree and
 * scratch paths are computed and stored in `jobspec_json` at booking time,
 * before pump/startRun does any filesystem I/O, so asserting on the stored
 * paths catches the actual defect without risking a real write under the
 * developer's real home the way exercising a run would.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { SafetyJournal } from '@clockwork/runner';
import { slugify } from '@clockwork/shared';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

// The real HOME never moves in this suite — CLOCKWORK_HOME is the only knob,
// exactly the scenario T1-15 was found under. Guarded once at module load so
// every reference below is a plain `string`, not `string | undefined`.
const REAL_HOME = process.env.HOME;
if (!REAL_HOME) throw new Error('HOME must be set to run this suite — it asserts real-home isolation');

let cwHome: string; // stands in for CLOCKWORK_HOME
let repoPath: string; // a real (bare) git repo, for the repo-task scenario
let clockworkHomeBefore: string | undefined;
let db: DB;
let clock: FakeClock;
let rm: RunManager;
let scheduler: Scheduler;
let app: FastifyInstance;
let token: string;
let dataDir: string;

const auth = (json: Record<string, unknown>): any => ({
  ...json,
  headers: { authorization: `Bearer ${token}` },
});

beforeEach(async () => {
  cwHome = mkdtempSync(path.join(os.tmpdir(), 'cw-home-isolation-'));
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'cw-home-isolation-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repoPath });

  clockworkHomeBefore = process.env.CLOCKWORK_HOME;
  process.env.CLOCKWORK_HOME = cwHome;
  // main.ts:415's own resolution, verbatim — proves the fix reads the same
  // value a real daemon would compute, not a value this test invented.
  dataDir = process.env.CLOCKWORK_HOME ?? `${process.env.HOME}/.clockwork`;

  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  clock = new FakeClock(Date.now());

  rm = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: '/nonexistent/runner-child.js', // never reached — nothing in this suite pumps
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dataDir}/journal.jsonl`),
  });
  scheduler = new Scheduler({ db, dataDir, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterEach(async () => {
  scheduler.stop();
  await app.close();
  db.close();
  if (clockworkHomeBefore === undefined) delete process.env.CLOCKWORK_HOME;
  else process.env.CLOCKWORK_HOME = clockworkHomeBefore;
  rmSync(cwHome, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  // The one invariant every test in this file depends on: nobody moved HOME.
  expect(process.env.HOME).toBe(REAL_HOME);
});

const createTask = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const res = await app.inject(
    auth({
      method: 'POST',
      url: '/tasks',
      payload: {
        name: 'CLOCKWORK_HOME isolation probe',
        prompt: 'Summarize open TODOs in this repo.',
        schedule: { kind: 'once' as const, runAt: Date.now() + 3_600_000, tz: 'UTC' },
        ...overrides,
      },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

const specOf = (runId: string): { worktreePath: string; scratchPath: string | null } => {
  const row = db.prepare('SELECT jobspec_json FROM runs WHERE id=?').get(runId) as { jobspec_json: string };
  return JSON.parse(row.jobspec_json);
};

/**
 * The exact path the pre-T1-15 hardcode (`${process.env.HOME}/.clockwork/...`)
 * would have produced for this run, under the REAL home. Booking never mkdirs
 * (pump/startRun does that), so this is a belt-and-suspenders check — the
 * `specOf` assertions above it are what actually go red pre-fix.
 */
const buggyPath = (kind: 'worktrees' | 'scratch', taskName: string, runId: string): string =>
  kind === 'worktrees'
    ? path.join(REAL_HOME, '.clockwork', 'worktrees', slugify(taskName), runId)
    : path.join(REAL_HOME, '.clockwork', 'scratch', runId);

describe('run-now (api.ts enqueueRunNow) respects CLOCKWORK_HOME', () => {
  it('books a repo-less run whose worktree and scratch paths live under CLOCKWORK_HOME, not the real home', async () => {
    const taskName = 'repo-less run-now probe';
    const taskId = await createTask({ name: taskName });

    const res = await app.inject(auth({ method: 'POST', url: `/tasks/${taskId}/run-now` }));
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json().runId as string;

    const spec = specOf(runId);
    expect(spec.worktreePath.startsWith(dataDir)).toBe(true);
    expect(spec.worktreePath.startsWith(REAL_HOME)).toBe(false);
    expect(spec.scratchPath).not.toBeNull();
    expect(spec.scratchPath!.startsWith(dataDir)).toBe(true);
    expect(spec.scratchPath!.startsWith(REAL_HOME)).toBe(false);

    expect(existsSync(buggyPath('worktrees', taskName, runId))).toBe(false);
    expect(existsSync(buggyPath('scratch', taskName, runId))).toBe(false);
  });

  it('books a repo run whose worktree path lives under CLOCKWORK_HOME, not the real home, and leaves scratchPath null', async () => {
    const taskName = 'repo run-now probe';
    const taskId = await createTask({ name: taskName, repoPath });

    const res = await app.inject(auth({ method: 'POST', url: `/tasks/${taskId}/run-now` }));
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json().runId as string;

    const spec = specOf(runId);
    expect(spec.worktreePath.startsWith(dataDir)).toBe(true);
    expect(spec.worktreePath.startsWith(REAL_HOME)).toBe(false);
    expect(spec.scratchPath).toBeNull(); // a repo task never gets a scratch dir

    expect(existsSync(buggyPath('worktrees', taskName, runId))).toBe(false);
  });
});

describe('a scheduled fire (scheduler.ts buildJobSpec) respects CLOCKWORK_HOME', () => {
  it('books a due occurrence whose worktree and scratch paths live under CLOCKWORK_HOME, not the real home', async () => {
    const taskName = 'scheduled fire probe';
    const taskId = await createTask({ name: taskName });
    db.prepare('UPDATE schedules SET next_fire=? WHERE task_id=?').run(clock.now() - 1000, taskId);

    scheduler.start(30_000); // immediate first tick (S-14) fires the overdue occurrence
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const row = db.prepare('SELECT id FROM runs WHERE task_id=?').get(taskId) as { id: string } | undefined;
    expect(row, 'the due occurrence should have fired a run row').toBeTruthy();
    const spec = specOf(row!.id);

    expect(spec.worktreePath.startsWith(dataDir)).toBe(true);
    expect(spec.worktreePath.startsWith(REAL_HOME)).toBe(false);
    expect(spec.scratchPath).not.toBeNull();
    expect(spec.scratchPath!.startsWith(dataDir)).toBe(true);
    expect(spec.scratchPath!.startsWith(REAL_HOME)).toBe(false);

    expect(existsSync(buggyPath('worktrees', taskName, row!.id))).toBe(false);
    expect(existsSync(buggyPath('scratch', taskName, row!.id))).toBe(false);
  });
});
