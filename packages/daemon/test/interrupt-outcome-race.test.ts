/**
 * An interrupted run must report WHAT INTERRUPTED IT, not "runner_crashed".
 *
 * THE DEFECT THIS FILE PINS
 *   Found on 2026-09-08 by running a real scheduled task against the installed
 *   app. A run stopped by its timeout reported `failed / runner_crashed`; so
 *   did one stopped by the USD soft cap. Reproducible 100% of the time, and
 *   invisible to every existing test: `interrupt-matrix.test.ts` asserts the
 *   runner RETURNS `timed_out`, and it does. The fault was one process later.
 *
 *   Mechanism. `finalize()` transitions the row to `finalizing` synchronously,
 *   then stops at its first `await`. The child, having written its outcome to
 *   stdout, exits immediately — so 'close' fires inside that gap. The close
 *   handler's guard asked whether the state was one of the five TERMINAL ones.
 *   `finalizing` is not terminal, so the guard let it through and it finalized
 *   a second time with `runner_crashed`, on top of the real outcome.
 *
 *   The enforcement was never wrong: the cap did stop the run, the timeout did
 *   stop the run. Only the name of what happened was wrong — which on a safety
 *   feature is the worst thing to get wrong, because the user reads "crashed"
 *   and files a bug against the thing that just protected them.
 *
 * WHY IT IS TESTED THROUGH A REAL CHILD PROCESS
 *   The bug lives in the seam between the runner and the daemon, so a test that
 *   calls `finalize()` twice by hand would only re-assert the fix's own logic.
 *   The stub child below writes an outcome and exits exactly as runner-child
 *   does, which is what makes 'close' land in the gap on every run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGAL_TRANSITIONS, TERMINAL_STATES, newId, type RunState } from '@clockwork/shared';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager, type RunManagerDeps } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { SafetyJournal } from '@clockwork/runner';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const NOW = Date.UTC(2026, 8, 8, 9, 0, 0);

let db: DB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-interrupt-race-'));
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON');
  createMigrator(db, MIGRATIONS).migrate();
});

afterEach(() => {
  if ((db as unknown as { open: boolean }).open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for runner-child: announce readiness, report the outcome the real
 * runner would have returned, then exit at once. The immediate exit is the
 * whole point — it is what puts 'close' inside finalize()'s first await.
 */
function stubChild(outcome: Record<string, unknown>): string {
  const file = path.join(dir, 'stub-child.mjs');
  writeFileSync(
    file,
    `process.stdout.write(JSON.stringify({ t: 'ready', nonce: process.argv[3] }) + '\\n');\n` +
      `process.stdout.write(JSON.stringify({ t: 'outcome', outcome: ${JSON.stringify(outcome)} }) + '\\n');\n` +
      `process.exit(0);\n`,
  );
  return file;
}

function makeManager(childModule: string, over: Partial<RunManagerDeps> = {}): RunManager {
  return new RunManager({
    db,
    clock: new FakeClock(NOW),
    dataDir: path.join(dir, 'data'),
    runnerChildModule: childModule,
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
    ...over,
  });
}

function seedRunningRun(): { runId: string; spec: Record<string, unknown> } {
  const runId = newId();
  const spec = {
    runId,
    taskId: 'task-x',
    taskName: 'Interrupt probe',
    taskSlug: 'interrupt-probe',
    prompt: 'p',
    engine: 'cli',
    permissionMode: 'plan',
    budget: { maxUsd: 5, maxTurns: 50, timeoutSec: 300 },
    repoPath: null,
    worktreePath: path.join(dir, 'wt'),
    delivery: { osNotify: false },
  };
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-x', 'Interrupt probe', 'p', ?, ?)`).run(NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
     VALUES (?, 'task-x', ?, 'running', ?, ?, ?)`,
  ).run(runId, JSON.stringify(spec), NOW, NOW, NOW);
  return { runId, spec };
}

function stateOf(runId: string): { state: string; outcome_reason: string | null } {
  return db.prepare(`SELECT state, outcome_reason FROM runs WHERE id=?`).get(runId) as {
    state: string;
    outcome_reason: string | null;
  };
}

async function waitForTerminal(runId: string): Promise<{ state: string; outcome_reason: string | null }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = stateOf(runId);
    if (['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(row.state)) return row;
    if (Date.now() > deadline) throw new Error(`run never went terminal — stuck in "${row.state}"`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a child that reports an outcome and exits', () => {
  // Every arm here failed before the fix, all with the same wrong answer.
  const cases = [
    { what: 'its timeout', outcome: { state: 'timed_out', artifacts: [], costUsd: 0.4, turns: 2 }, expect: 'timed_out', reason: null },
    { what: 'the USD soft cap', outcome: { state: 'budget_exceeded', artifacts: [], costUsd: 0.6, turns: 1 }, expect: 'budget_exceeded', reason: null },
    { what: 'max turns', outcome: { state: 'failed', failureReason: 'max_turns', artifacts: [], costUsd: 0.2, turns: 5 }, expect: 'failed', reason: 'max_turns' },
    { what: 'cancellation', outcome: { state: 'cancelled', artifacts: [], costUsd: 0, turns: 0 }, expect: 'cancelled', reason: null },
  ];

  for (const c of cases) {
    it(`keeps "${c.expect}" when the run was stopped by ${c.what}`, async () => {
      const { runId, spec } = seedRunningRun();
      const rm = makeManager(stubChild(c.outcome));
      await rm.spawnChild(runId, spec as never, NOW);
      const row = await waitForTerminal(runId);

      expect(row.state, 'the exit path overwrote the real outcome').toBe(c.expect);
      expect(row.outcome_reason ?? null).toBe(c.reason);
      expect(row.outcome_reason, 'runner_crashed is what this bug wrote over everything').not.toBe('runner_crashed');
    });
  }

  it('still reports runner_crashed when the child really does die silently', async () => {
    // The fix must not become a blanket amnesty: a child that exits with no
    // outcome at all is the case the close handler exists for.
    const { runId, spec } = seedRunningRun();
    const silent = path.join(dir, 'silent-child.mjs');
    writeFileSync(silent, `process.stdout.write(JSON.stringify({ t: 'ready', nonce: process.argv[3] }) + '\\n');\nprocess.exit(1);\n`);
    const rm = makeManager(silent);
    await rm.spawnChild(runId, spec as never, NOW);
    const row = await waitForTerminal(runId);

    expect(row.state).toBe('failed');
    expect(row.outcome_reason).toBe('runner_crashed');
  });

  /**
   * The class of bug, not just this instance.
   *
   * `finalize()` is the ONLY writer of a terminal run state and it always goes
   * through `finalizing` first, so any terminal state it can produce must be
   * reachable from there. Two were not, and nothing said so until a real run
   * hit one — the throw was swallowed by a `catch` meant for a different case.
   * `missed` is excluded because it is set on a run that never started.
   */
  it('lets finalizing reach every terminal state finalize() can write', () => {
    const reachable = new Set(LEGAL_TRANSITIONS.finalizing);
    const unreachable = [...TERMINAL_STATES]
      .filter((s): s is RunState => s !== 'missed')
      .filter((s) => !reachable.has(s));
    expect(unreachable, 'a run finalizing into these would be stranded mid-state').toEqual([]);
  });
});
