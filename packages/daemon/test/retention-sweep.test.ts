/**
 * Retention sweep atomicity + approvals cascade (bug: verified against a live
 * daemon — `POST /retention/sweep` returned an unhandled 500 and pruned
 * NOTHING the moment a single `approvals` row pointed at any run in the
 * delete set).
 *
 * `approvals.run_id TEXT NOT NULL REFERENCES runs(id)` (0001_init.sql) had no
 * `ON DELETE CASCADE`. With `foreign_keys = ON` (db.ts), the bare
 * `DELETE FROM runs ...` in retention-audit.ts sweep() aborted the whole
 * statement (SQLite's default FK-violation behavior rolls back the entire
 * statement, not just the offending row) — so every user who ever answered
 * one approval had history pruning silently disabled forever.
 *
 * Fix: migration 0010 rebuilds `approvals` with `run_id ... ON DELETE
 * CASCADE`, matching the FOREIGN-KEY RULE migration 0008 already documents
 * (and already applies to `run_outcomes`/`autonomy_decisions`) — sweep() also
 * now runs its three deletes inside a single transaction so a partial sweep
 * can never commit.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RetentionAudit } from '../src/retention-audit.js';
import { newId } from '@clockwork/shared';

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-retention-db-'));
  const db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  return { db, dir };
}

function insertTask(db: DB, id: string, now: number): void {
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, 't', 'p', ?, ?)`,
  ).run(id, now, now);
}

function insertRun(
  db: DB,
  id: string,
  taskId: string,
  state: string,
  endedAt: number,
): void {
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, ended_at, scheduled_for)
     VALUES (?, ?, '{}', ?, ?, ?, ?)`,
  ).run(id, taskId, state, endedAt, endedAt, endedAt);
}

function insertApproval(db: DB, id: string, runId: string, now: number): void {
  db.prepare(
    `INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback)
     VALUES (?, ?, 'permission', '{}', ?, ?, 'deny')`,
  ).run(id, runId, now, now + 60_000);
}

describe('RetentionAudit.sweep — approvals present (regression)', () => {
  let db: DB;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = freshDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not throw and prunes an expired run even when an approvals row points at it', () => {
    const audit = new RetentionAudit(db);
    audit.setPrefs(30, null); // prune terminal runs older than 30 days
    const now = Date.now();
    const taskId = newId();
    insertTask(db, taskId, now);

    const oldRunId = newId();
    const oldEndedAt = now - 40 * 86_400_000; // 40 days ago — outside the 30-day window
    insertRun(db, oldRunId, taskId, 'completed', oldEndedAt);
    const approvalId = newId();
    insertApproval(db, approvalId, oldRunId, oldEndedAt);

    // BEFORE the fix, this call throws a FOREIGN KEY constraint error (or
    // the sweep silently deletes nothing) — either way `runs` still has the
    // stale row afterward. AFTER the fix it must complete and prune.
    expect(() => audit.sweep(now)).not.toThrow();

    const remainingRun = db.prepare('SELECT id FROM runs WHERE id=?').get(oldRunId);
    expect(remainingRun, 'expired run must be pruned').toBeUndefined();

    const remainingApproval = db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalId);
    expect(remainingApproval, 'approvals row must cascade-delete with its run').toBeUndefined();
  });

  it('keeps a run inside the retention window, and keeps its approvals row untouched', () => {
    const audit = new RetentionAudit(db);
    audit.setPrefs(30, null);
    const now = Date.now();
    const taskId = newId();
    insertTask(db, taskId, now);

    const recentRunId = newId();
    const recentEndedAt = now - 5 * 86_400_000; // 5 days ago — inside the 30-day window
    insertRun(db, recentRunId, taskId, 'completed', recentEndedAt);
    const approvalId = newId();
    insertApproval(db, approvalId, recentRunId, recentEndedAt);

    const oldRunId = newId();
    const oldEndedAt = now - 40 * 86_400_000;
    insertRun(db, oldRunId, taskId, 'completed', oldEndedAt);
    insertApproval(db, newId(), oldRunId, oldEndedAt);

    const deleted = audit.sweep(now);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT id FROM runs WHERE id=?').get(recentRunId), 'run inside window must survive').toBeDefined();
    expect(db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalId), 'its approval must survive').toBeDefined();
    expect(db.prepare('SELECT id FROM runs WHERE id=?').get(oldRunId), 'expired run must still be pruned').toBeUndefined();
  });

  it('never prunes a non-terminal run regardless of age, approvals or not', () => {
    const audit = new RetentionAudit(db);
    audit.setPrefs(30, null);
    const now = Date.now();
    const taskId = newId();
    insertTask(db, taskId, now);

    const runningId = newId();
    // 'running' has no ended_at; scheduled_for is old, but state excludes it from pruning.
    db.prepare(
      `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, scheduled_for) VALUES (?, ?, '{}', 'running', ?, ?)`,
    ).run(runningId, taskId, now - 40 * 86_400_000, now - 40 * 86_400_000);
    insertApproval(db, newId(), runningId, now - 40 * 86_400_000);

    audit.sweep(now);

    expect(db.prepare('SELECT id FROM runs WHERE id=?').get(runningId), 'non-terminal run must never be pruned').toBeDefined();
  });

  it('cap-based pruning (maxRuns) cascades approvals for runs pushed out of the cap', () => {
    const audit = new RetentionAudit(db);
    audit.setPrefs(null, 2); // keep only the 2 most recent terminal runs per task
    const now = Date.now();
    const taskId = newId();
    insertTask(db, taskId, now);

    // 4 terminal runs, oldest to newest; only the newest 2 should survive.
    const ids = [0, 1, 2, 3].map(() => newId());
    const approvalIds = ids.map(() => newId());
    ids.forEach((id, i) => {
      const endedAt = now - (4 - i) * 3600_000; // ascending recency
      insertRun(db, id, taskId, 'completed', endedAt);
      insertApproval(db, approvalIds[i], id, endedAt);
    });

    expect(() => audit.sweep(now)).not.toThrow();

    const survivingRuns = db.prepare('SELECT id FROM runs WHERE task_id=?').all(taskId) as Array<{ id: string }>;
    expect(survivingRuns.map((r) => r.id).sort()).toEqual([ids[2], ids[3]].sort());

    // The pruned runs' approvals must cascade away; the kept runs' approvals must remain.
    expect(db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalIds[0])).toBeUndefined();
    expect(db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalIds[1])).toBeUndefined();
    expect(db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalIds[2])).toBeDefined();
    expect(db.prepare('SELECT id FROM approvals WHERE id=?').get(approvalIds[3])).toBeDefined();
  });

  it('a later delete failing inside the sweep rolls back the earlier one — no half-deleted state', () => {
    // sweep() issues 3 deletes in order: runs (window), runs (cap), trigger_events
    // (window). This test is unrelated to the approvals FK — it isolates the
    // OTHER half of the fix (retention-audit.ts wrapping all three in one
    // db.transaction) by forcing the THIRD delete to fail with a plain SQL
    // error, after the FIRST would already have run. A single transaction
    // rolls the runs delete back too; a sequence of independent
    // auto-committing statements (the pre-fix shape) would not — the runs
    // delete would already be durable by the time the third statement throws.
    const audit = new RetentionAudit(db);
    audit.setPrefs(30, null); // runs-window delete + trigger_events-window delete both fire; maxRuns null skips the cap delete
    const now = Date.now();
    const taskId = newId();
    insertTask(db, taskId, now);
    const oldRunId = newId();
    const oldEndedAt = now - 40 * 86_400_000; // outside the 30-day window — the runs delete would otherwise prune it
    insertRun(db, oldRunId, taskId, 'completed', oldEndedAt);

    db.exec('DROP TABLE trigger_events'); // makes the sweep's 3rd DELETE fail for a real, unrelated reason

    expect(() => audit.sweep(now)).toThrow();
    const survivingRun = db.prepare('SELECT id FROM runs WHERE id=?').get(oldRunId);
    expect(survivingRun, 'the runs delete must roll back when a later delete in the same sweep fails').toBeDefined();
  });
});
