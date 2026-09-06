/**
 * Run-side policies (T-106/T-110):
 * - S-40/S-41: auth failure → fail fast + auto-pause recurring task after 2
 *   consecutive auth failures.
 * - S-42: rate-limit backoff for retry_on_transient tasks (+30min, max 2).
 * - FR-19 retention pruning.
 */
import { rmSync } from 'node:fs';
import type { DB } from './db.js';

/**
 * Consecutive-failure tracker per task (auth class only).
 *
 * S-review (high): F8 self-healing writes the SAME row for the work-failure
 * class (`self-healing.ts` onRunFailed, `kind='failure'`) — that sharing is the
 * spec's design. This function used to add 1 to whatever it found there, so one
 * ordinary failure followed by ONE auth failure reached 2 and paused the task,
 * quietly rewriting S-40/S-41 from "2 consecutive AUTH failures" to "1 auth
 * failure preceded by any failure". The count restarts at 1 whenever the row it
 * finds was opened by another class, which is what "consecutive auth" means.
 * Columns are table-qualified because `kind='auth'` is assigned in this same
 * SET list; SQLite evaluates every SET expression against the pre-update row,
 * and the qualification says so out loud.
 */
export function recordAuthFailureAndMaybePause(db: DB, taskId: string): { paused: boolean; consecutive: number } {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_failure_streaks (task_id, kind, count, last_at) VALUES (?, 'auth', 1, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       count = CASE WHEN task_failure_streaks.kind = 'auth' THEN task_failure_streaks.count + 1 ELSE 1 END,
       last_at = ?, kind='auth'`,
  ).run(taskId, now, now);
  const row = db.prepare('SELECT count FROM task_failure_streaks WHERE task_id=?').get(taskId) as any;
  if (row.count >= 2) {
    db.prepare('UPDATE tasks SET enabled=0, updated_at=? WHERE id=?').run(now, taskId);
    return { paused: true, consecutive: row.count };
  }
  return { paused: false, consecutive: row.count };
}

export function clearFailureStreak(db: DB, taskId: string): void {
  db.prepare('DELETE FROM task_failure_streaks WHERE task_id=?').run(taskId);
}

export interface BackoffDecision {
  retry: boolean;
  delayMs?: number;
}

/** S-42: scheduler-level backoff when task opted into retry_on_transient. */
export function transientBackoff(db: DB, taskId: string): BackoffDecision {
  const t = db.prepare('SELECT retry_on_transient FROM tasks WHERE id=?').get(taskId) as any;
  if (!t?.retry_on_transient) return { retry: false };
  const recent = db
    .prepare(`SELECT COUNT(*) c FROM runs WHERE task_id=? AND outcome_reason IN ('rate_limited','capacity','offline') AND ended_at > ?`)
    .get(taskId, Date.now() - 24 * 3600_000) as any;
  if (recent.c >= 2) return { retry: false }; // max 2 retries/day
  return { retry: true, delayMs: 30 * 60_000 };
}

/**
 * FR-19 retention: worktrees of successful runs deleted after 7d; failed kept
 * 30d; reports kept forever. Branches retained with the run's disposition.
 */
export function pruneExpired(db: DB, dataDir: string, now = Date.now()): { removedWorktrees: number } {
  let removed = 0;
  const SUCCESS_MS = 7 * 86_400_000;
  const FAILED_MS = 30 * 86_400_000;

  const candidates = db
    .prepare(
      `SELECT id, worktree_path, state, ended_at FROM runs
       WHERE worktree_path IS NOT NULL AND ended_at IS NOT NULL AND worktree_pruned=0`,
    )
    .all() as unknown as Array<{ id: string; worktree_path: string; state: string; ended_at: number }>;

  for (const r of candidates) {
    const age = now - r.ended_at;
    const limit = ['completed'].includes(r.state) ? SUCCESS_MS : FAILED_MS;
    if (age < limit) continue;
    try {
      rmRecursive(r.worktree_path);
      removed++;
      db.prepare('UPDATE runs SET worktree_pruned=1 WHERE id=?').run(r.id);
    } catch {
      /* already gone or locked — retried next sweep */
    }
  }
  void dataDir;
  return { removedWorktrees: removed };
}

function rmRecursive(p: string): void {
  rmSync(p, { recursive: true, force: true });
}
