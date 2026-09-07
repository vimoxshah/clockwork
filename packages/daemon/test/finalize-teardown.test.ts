/**
 * `finalize()`'s post-commit tail must never redden the process.
 *
 * THE DEFECT THIS FILE PINS
 *   Roughly one full-suite run in three reported `752 passed` next to
 *   `Errors 1 error` and exited non-zero. Reproduced here on 2026-09-06 at run
 *   10 of 12 consecutive `rtk proxy pnpm test` runs:
 *
 *     Unhandled Rejection
 *     TypeError: The database connection is not open
 *      ❯ RunManager.recordEvent packages/daemon/src/run-manager.ts:876:8
 *      ❯ RunManager.finalize    packages/daemon/src/run-manager.ts:649:12
 *     This error originated in "test/api.test.ts"
 *
 *   Mechanism: `finalize()` commits its transaction synchronously, then runs an
 *   ADVISORY tail — F2 handoff, F1 plan/execute, F4 sentinel, F8 self-healing,
 *   the S-40/S-41 streak bookkeeping, delivery and chain firing — with an
 *   `await import(...)` in front of each. Every one of those awaits is a gap a
 *   shutdown (or an `afterAll`) can close the handle in. The hook then throws
 *   `The database connection is not open`, its `catch` block calls
 *   `recordEvent`, and THAT throws too, because the write it makes hits the
 *   same closed handle. Nothing below catches it, and `finalize()` is fired and
 *   forgotten at five call sites, so the rejection has no owner and becomes an
 *   unhandled rejection: no test fails, and the process still exits non-zero.
 *
 * WHAT THE TESTS BELOW ASSERT
 *   1. Closing the database mid-finalize raises no unhandled rejection.
 *   2. The commit still lands, so the fix is a boundary and not a bail-out.
 *   3. A hook that throws while the handle is OPEN is still recorded as a note
 *      — the fix must not become a blanket swallow.
 *   4. A genuine write fault while the handle is OPEN still throws out of
 *      `recordEvent`; only the CLOSED handle is silent.
 *   5. The real floating call site (`cancel()`) catches a finalize failure and
 *      surfaces it on stderr instead of leaving it unhandled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@clockwork/shared';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager, type RunManagerDeps } from '../src/run-manager.js';
import { FakeClock } from '../src/clock.js';
import { SafetyJournal } from '@clockwork/runner';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const NOW = Date.UTC(2026, 8, 6, 9, 0, 0);

let db: DB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cw-finalize-teardown-'));
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
});

afterEach(() => {
  // Several tests close the handle on purpose; closing twice throws.
  if ((db as unknown as { open: boolean }).open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(over: Partial<RunManagerDeps> = {}): RunManager {
  return new RunManager({
    db,
    clock: new FakeClock(NOW),
    dataDir: path.join(dir, 'data'),
    runnerChildModule: '/nonexistent.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
    ...over,
  });
}

/** A `running` row, the state the child-exit and watchdog paths finalize from. */
function seedRunningRun(): string {
  const runId = newId();
  db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-x', 'Teardown probe', 'p', ?, ?)`).run(NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
     VALUES (?, 'task-x', ?, 'running', ?, ?, ?)`,
  ).run(runId, JSON.stringify({ runId, taskId: 'task-x', taskName: 'Teardown probe' }), NOW, NOW, NOW);
  return runId;
}

const CRASH_OUTCOME = { state: 'failed' as const, failureReason: 'runner_crashed' as const, artifacts: [], costUsd: 0, turns: 0 };
const DONE_OUTCOME = { state: 'completed' as const, artifacts: [], costUsd: 0, turns: 0 };

/** Give Node several macrotasks to deliver an `unhandledRejection`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

function noteText(runId: string): string {
  const rows = db.prepare(`SELECT data_json FROM events WHERE run_id=? AND kind='note'`).all(runId) as Array<{ data_json: string }>;
  return rows.map((r) => r.data_json).join(' ');
}

describe('finalize() against a database that closes underneath it', () => {
  it('raises no unhandled rejection when the handle closes mid-tail', async () => {
    const runId = seedRunningRun();
    const rm = makeManager();

    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // DELIBERATELY FLOATING — this is exactly how run-manager.ts calls
      // finalize from the child-close handler, both watchdogs, the outcome
      // message and cancel(). finalize() runs synchronously through its commit
      // and stops at the first `await import(...)`, so closing the handle on
      // the very next line lands inside that gap on every run: the race CI hits
      // by luck, made deterministic.
      void rm.finalize(runId, CRASH_OUTCOME);
      db.close();
      await settle();

      expect(captured, `finalize() rejected into nobody's hands: ${captured.map(String).join(' | ')}`).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still commits the terminal state before the tail gives up', async () => {
    // The fix is a boundary around the ADVISORY tail, not a bail-out: the run
    // must still be durably terminal even though the handle went away.
    const runId = seedRunningRun();
    const file = path.join(dir, 'durable.sqlite');
    const disk = new Database(file) as unknown as DB;
    disk.pragma('foreign_keys = ON');
    createMigrator(disk, MIGRATIONS).migrate();
    disk.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('task-x', 'Teardown probe', 'p', ?, ?)`).run(NOW, NOW);
    disk
      .prepare(
        `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, started_at, scheduled_for)
         VALUES (?, 'task-x', ?, 'running', ?, ?, ?)`,
      )
      .run(runId, JSON.stringify({ runId, taskId: 'task-x', taskName: 'Teardown probe' }), NOW, NOW, NOW);

    const rm = new RunManager({
      db: disk,
      clock: new FakeClock(NOW),
      dataDir: path.join(dir, 'data'),
      runnerChildModule: '/nonexistent.js',
      notify: () => {},
      broadcast: () => {},
      safetyJournal: new SafetyJournal(path.join(dir, 'journal.jsonl')),
    });
    void rm.finalize(runId, CRASH_OUTCOME);
    disk.close();
    await settle();

    const reopened = new Database(file, { readonly: true }) as unknown as DB;
    try {
      const row = reopened.prepare('SELECT state, ended_at FROM runs WHERE id=?').get(runId) as { state: string; ended_at: number | null };
      expect(row.state).toBe('failed');
      expect(row.ended_at).toBe(NOW);
    } finally {
      reopened.close();
    }
  });
});

describe('the boundary is a boundary, not a blanket swallow', () => {
  it('records a throwing F4 sentinel hook as a note and finishes the run', async () => {
    const runId = seedRunningRun();
    const rm = makeManager({
      onSentinelFinalize: () => {
        throw new Error('SENTINEL_BOOM');
      },
    });

    await rm.finalize(runId, DONE_OUTCOME);

    expect(noteText(runId)).toContain('SENTINEL_BOOM');
    expect((db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state).toBe('completed');
  });

  it('records a throwing F1 plan/execute hook as a note (the pre-existing boundary is intact)', async () => {
    const runId = seedRunningRun();
    const rm = makeManager({
      planExecute: {
        onPlanRunFinalized: () => {
          throw new Error('PLAN_BOOM');
        },
      },
    });

    await rm.finalize(runId, DONE_OUTCOME);

    expect(noteText(runId)).toContain('PLAN_BOOM');
  });

  it('still throws on a genuine write fault while the handle is OPEN', async () => {
    // Only the CLOSED handle is silent. A missing table is a real fault and
    // must keep propagating, or the guard would have turned recordEvent into a
    // place where writes quietly disappear.
    const runId = seedRunningRun();
    const rm = makeManager();
    db.exec('DROP TABLE events');

    await expect(rm.finalize(runId, DONE_OUTCOME)).rejects.toThrow(/no such table: events/);
  });
});

describe('the floating call sites own their rejections', () => {
  it('cancel() catches a finalize failure and surfaces it instead of leaving it unhandled', async () => {
    const runId = seedRunningRun();
    const rm = makeManager();
    db.exec('DROP TABLE events'); // makes finalize fail for a REAL reason, handle still open

    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(rm.cancel(runId)).toBe(true);
      await settle();

      expect(captured, `cancel() left a rejection unowned: ${captured.map(String).join(' | ')}`).toEqual([]);
      // Caught is not the same as hidden: the failure still has a voice.
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.join(' '))).toContain(runId);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      stderr.mockRestore();
    }
  });
});
