/**
 * F4 sentinel-worker (plan/AGENT-WORKFORCE-SPEC.md).
 *
 * Covers `Sentinels.create/list/remove/trips/evaluate` and the pure
 * `tripped()` matcher against a real migration-0008 schema. `evaluate()` is
 * the interesting surface: it is called from run-manager's generic finalize
 * hook for every run, not only sentinel runs, so most of these tests defend
 * the refusal/no-op paths (not-a-sentinel-task, disabled, no-match, cooldown,
 * disabled trigger, policy violation) rather than only the happy trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { Sentinels, tripped } from '../src/sentinel.js';
import type { SentinelCreate } from '@clockwork/shared';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let db: DB;

beforeEach(() => {
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
});

afterEach(() => db.close());

let taskSeq = 0;
function addTask(overrides: { deleted?: boolean } = {}): string {
  const id = `task_${++taskSeq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, created_at, updated_at, deleted_at) VALUES (?, ?, 'p', ?, ?, ?)`,
  ).run(id, id, now, now, overrides.deleted ? now : null);
  return id;
}

let triggerSeq = 0;
function addTrigger(taskId: string, opts: { enabled?: number } = {}): string {
  const id = `trg_${++triggerSeq}`;
  db.prepare(
    `INSERT INTO triggers (id, name, source, task_id, enabled, created_at) VALUES (?, ?, 'webhook', ?, ?, ?)`,
  ).run(id, id, taskId, opts.enabled ?? 1, Date.now());
  return id;
}

function reportWith(summary: string): string {
  return JSON.stringify({ summary });
}

function makeCreate(overrides: Partial<SentinelCreate> & { sentinelTaskId: string; triggerId: string }): SentinelCreate {
  return {
    name: 'watch it',
    tripExpr: 'ERROR',
    cooldownSec: 3600,
    enabled: true,
    ...overrides,
  };
}

describe('Sentinels.create', () => {
  it('creates a sentinel bound to an existing task and trigger, cooldown/lastTrippedAt honest at birth', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => null });

    const result = sentinels.create(makeCreate({ sentinelTaskId, triggerId }));

    expect('error' in result).toBe(false);
    const s = result as Exclude<typeof result, { error: string }>;
    expect(s.sentinelTaskId).toBe(sentinelTaskId);
    expect(s.triggerId).toBe(triggerId);
    expect(s.lastTrippedAt).toBeNull();
    expect(s.enabled).toBe(true);
  });

  it('rejects an unknown sentinel task', () => {
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => null });

    const result = sentinels.create(makeCreate({ sentinelTaskId: 'nope', triggerId }));

    expect(result).toEqual({ error: expect.stringContaining('sentinel task') });
    expect(db.prepare('SELECT COUNT(*) c FROM sentinels').get()).toEqual({ c: 0 });
  });

  it('rejects an unknown trigger', () => {
    const sentinelTaskId = addTask();
    const sentinels = new Sentinels({ db, bookWorker: () => null });

    const result = sentinels.create(makeCreate({ sentinelTaskId, triggerId: 'nope' }));

    expect(result).toEqual({ error: expect.stringContaining('trigger') });
    expect(db.prepare('SELECT COUNT(*) c FROM sentinels').get()).toEqual({ c: 0 });
  });

  it('refuses a sentinel that would book its own task — an infinite loop', () => {
    const sentinelTaskId = addTask();
    const triggerId = addTrigger(sentinelTaskId); // trigger's task IS the sentinel task
    const sentinels = new Sentinels({ db, bookWorker: () => null });

    const result = sentinels.create(makeCreate({ sentinelTaskId, triggerId }));

    expect(result).toEqual({ error: expect.stringContaining('own') });
    expect(db.prepare('SELECT COUNT(*) c FROM sentinels').get()).toEqual({ c: 0 });
  });
});

describe('Sentinels.list / remove', () => {
  it('lists created sentinels newest first', async () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => null });

    const a = sentinels.create(makeCreate({ sentinelTaskId, triggerId, name: 'a' }), 1_000);
    const b = sentinels.create(makeCreate({ sentinelTaskId, triggerId, name: 'b' }), 2_000);

    const list = sentinels.list();
    expect(list.map((s) => s.name)).toEqual(['b', 'a']);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
  });

  it('removes an existing sentinel and reports false for an unknown id', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => null });
    const created = sentinels.create(makeCreate({ sentinelTaskId, triggerId }));
    const id = (created as { id: string }).id;

    expect(sentinels.remove('does-not-exist')).toBe(false);
    expect(sentinels.remove(id)).toBe(true);
    expect(sentinels.list()).toEqual([]);
  });

  it('cascades: deleting the bound trigger deletes the sentinel and its trips', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => 'worker-run-1' });
    const created = sentinels.create(makeCreate({ sentinelTaskId, triggerId, cooldownSec: 0 }));
    const id = (created as { id: string }).id;
    sentinels.evaluate('sentinel-run-1', sentinelTaskId, reportWith('an ERROR occurred'), 1_000);
    expect(sentinels.trips(id)).toHaveLength(1);

    db.prepare('DELETE FROM triggers WHERE id=?').run(triggerId);

    expect(db.prepare('SELECT COUNT(*) c FROM sentinels').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM sentinel_trips').get()).toEqual({ c: 0 });
  });
});

describe('Sentinels.evaluate — refusal and no-op paths', () => {
  it('is a no-op — returns null and writes nothing — for a task that is not a sentinel', () => {
    const someTaskId = addTask();
    const sentinels = new Sentinels({ db, bookWorker: () => 'worker-run' });

    const result = sentinels.evaluate('run-1', someTaskId, reportWith('ERROR'), 1_000);

    expect(result).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM sentinel_trips').get()).toEqual({ c: 0 });
  });

  it('a disabled sentinel books nothing and records reason=disabled', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    let booked = false;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        booked = true;
        return 'worker-run';
      },
    });
    const created = sentinels.create(makeCreate({ sentinelTaskId, triggerId, enabled: false }));
    const id = (created as { id: string }).id;

    const trip = sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);

    expect(trip).toMatchObject({ sentinelId: id, tripped: false, reason: 'disabled', workerRunId: null });
    expect(booked).toBe(false);
  });

  it('a report that does not match trip_expr books nothing and records reason=no_match', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    let booked = false;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        booked = true;
        return 'worker-run';
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId, tripExpr: 'ERROR' }));

    const trip = sentinels.evaluate('run-1', sentinelTaskId, reportWith('all green, nothing to see'), 1_000);

    expect(trip).toMatchObject({ tripped: false, reason: 'no_match', workerRunId: null });
    expect(booked).toBe(false);
  });

  it('suppresses a re-trip inside the cooldown window and leaves last_tripped_at untouched', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    let bookCalls = 0;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        bookCalls++;
        return `worker-run-${bookCalls}`;
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId, cooldownSec: 3600 }));

    const first = sentinels.evaluate('run-1', sentinelTaskId, reportWith('an ERROR occurred'), 1_000);
    expect(first).toMatchObject({ tripped: true, reason: null, workerRunId: 'worker-run-1' });
    expect(bookCalls).toBe(1);

    // still inside the 3600s cooldown window
    const second = sentinels.evaluate('run-2', sentinelTaskId, reportWith('an ERROR occurred'), 1_000 + 60_000);
    expect(second).toMatchObject({ tripped: false, reason: 'cooldown', workerRunId: null });
    expect(bookCalls).toBe(1); // not booked again

    const sentinelRow = db.prepare('SELECT last_tripped_at FROM sentinels WHERE sentinel_task_id=?').get(sentinelTaskId) as {
      last_tripped_at: number;
    };
    expect(sentinelRow.last_tripped_at).toBe(1_000); // untouched by the suppressed second trip
  });

  it('books again once the cooldown has expired', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    let bookCalls = 0;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        bookCalls++;
        return `worker-run-${bookCalls}`;
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId, cooldownSec: 60 }));

    sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);
    expect(bookCalls).toBe(1);

    // 61s later — cooldown (60s) has expired
    const second = sentinels.evaluate('run-2', sentinelTaskId, reportWith('ERROR'), 1_000 + 61_000);
    expect(second).toMatchObject({ tripped: true, reason: null, workerRunId: 'worker-run-2' });
    expect(bookCalls).toBe(2);
  });

  it('books the trigger\'s worker task, not the sentinel\'s own task', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const bookedTaskIds: string[] = [];
    const sentinels = new Sentinels({
      db,
      bookWorker: (taskId) => {
        bookedTaskIds.push(taskId);
        return 'worker-run-1';
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId }));

    sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);

    expect(bookedTaskIds).toEqual([workerTaskId]);
  });

  it('a disabled trigger books nothing and records reason=trigger_disabled, even though the sentinel itself is enabled and matched', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId, { enabled: 0 });
    let booked = false;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        booked = true;
        return 'worker-run';
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId }));

    const trip = sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);

    expect(trip).toMatchObject({ tripped: false, reason: 'trigger_disabled', workerRunId: null });
    expect(booked).toBe(false);
  });

  it('records reason=policy_violation when bookWorker refuses, and does not start the cooldown clock — the next evaluation retries immediately', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    let bookCalls = 0;
    const sentinels = new Sentinels({
      db,
      bookWorker: () => {
        bookCalls++;
        return bookCalls === 1 ? null : 'worker-run-2'; // first refused by policy, second succeeds
      },
    });
    sentinels.create(makeCreate({ sentinelTaskId, triggerId, cooldownSec: 3600 }));

    const first = sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);
    expect(first).toMatchObject({ tripped: false, reason: 'policy_violation', workerRunId: null });

    const sentinelRow = db.prepare('SELECT last_tripped_at FROM sentinels WHERE sentinel_task_id=?').get(sentinelTaskId) as {
      last_tripped_at: number | null;
    };
    expect(sentinelRow.last_tripped_at).toBeNull(); // a failed attempt must not arm the cooldown

    // Immediately after (well inside the 3600s cooldown, but nothing ever booked) — retries and succeeds.
    const second = sentinels.evaluate('run-2', sentinelTaskId, reportWith('ERROR'), 1_000 + 1);
    expect(second).toMatchObject({ tripped: true, reason: null, workerRunId: 'worker-run-2' });
  });

  it('evaluates every sentinel bound to the same task and writes one trip row each, returning the first', () => {
    const sentinelTaskId = addTask();
    const workerTaskA = addTask();
    const workerTaskB = addTask();
    const triggerA = addTrigger(workerTaskA);
    const triggerB = addTrigger(workerTaskB);
    const bookedTaskIds: string[] = [];
    const sentinels = new Sentinels({
      db,
      bookWorker: (taskId) => {
        bookedTaskIds.push(taskId);
        return `run-for-${taskId}`;
      },
    });
    const a = sentinels.create(makeCreate({ sentinelTaskId, triggerId: triggerA, name: 'a' }));
    const b = sentinels.create(makeCreate({ sentinelTaskId, triggerId: triggerB, name: 'b' }));

    const result = sentinels.evaluate('run-1', sentinelTaskId, reportWith('ERROR'), 1_000);

    expect(result).not.toBeNull();
    expect(bookedTaskIds.sort()).toEqual([workerTaskA, workerTaskB].sort());
    expect(sentinels.trips((a as { id: string }).id)).toHaveLength(1);
    expect(sentinels.trips((b as { id: string }).id)).toHaveLength(1);
  });
});

describe('Sentinels.trips', () => {
  it('returns trips newest first and respects limit', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => 'worker-run' });
    const created = sentinels.create(makeCreate({ sentinelTaskId, triggerId, cooldownSec: 0 }));
    const id = (created as { id: string }).id;

    sentinels.evaluate('run-1', sentinelTaskId, reportWith('no match here'), 1_000);
    sentinels.evaluate('run-2', sentinelTaskId, reportWith('an ERROR occurred'), 2_000);
    sentinels.evaluate('run-3', sentinelTaskId, reportWith('another ERROR'), 3_000);

    const all = sentinels.trips(id);
    expect(all.map((t) => t.at)).toEqual([3_000, 2_000, 1_000]);

    const limited = sentinels.trips(id, 2);
    expect(limited.map((t) => t.at)).toEqual([3_000, 2_000]);
  });

  it('returns nothing for a sentinel with no trips yet', () => {
    const sentinelTaskId = addTask();
    const workerTaskId = addTask();
    const triggerId = addTrigger(workerTaskId);
    const sentinels = new Sentinels({ db, bookWorker: () => null });
    const created = sentinels.create(makeCreate({ sentinelTaskId, triggerId }));

    expect(sentinels.trips((created as { id: string }).id)).toEqual([]);
  });
});

describe('tripped()', () => {
  it('matches case-insensitively against the report summary', () => {
    expect(tripped(reportWith('an ERROR occurred'), 'error')).toBe(true);
    expect(tripped(reportWith('an error occurred'), 'ERROR')).toBe(true);
  });

  it('returns false when the substring is absent', () => {
    expect(tripped(reportWith('all green'), 'ERROR')).toBe(false);
  });

  it('returns false for a null report', () => {
    expect(tripped(null, 'ERROR')).toBe(false);
  });

  it('returns false for malformed JSON rather than throwing', () => {
    expect(tripped('{not json', 'ERROR')).toBe(false);
  });

  it('returns false when the report has no summary field', () => {
    expect(tripped(JSON.stringify({ state: 'completed' }), 'ERROR')).toBe(false);
  });
});
