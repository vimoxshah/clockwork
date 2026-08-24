/**
 * Retention + audit (ADR-031): goal #41 retention controls and #40 audit log.
 *
 * Retention sweep prunes terminal runs beyond the configured window/cap.
 * Audit log records control-plane mutations with a result snapshot —
 * append-only, never includes credentials.
 */
import type { DB } from './db.js';

export interface AuditEntry {
  at: number;
  actor?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

export class RetentionAudit {
  constructor(private readonly db: DB) {}

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS retention_prefs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_days INTEGER,
      max_runs INTEGER
    )`);
    this.db.exec(`INSERT OR IGNORE INTO retention_prefs (id, run_days, max_runs) VALUES (1, 90, 1000)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail_json TEXT
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC)`);
  }

  // ---- retention ----

  getPrefs(): { runDays: number | null; maxRuns: number | null } {
    this.ensureSchema();
    const row = this.db.prepare('SELECT run_days, max_runs FROM retention_prefs WHERE id = 1').get() as
      | { run_days: number | null; max_runs: number | null }
      | undefined;
    return { runDays: row?.run_days ?? null, maxRuns: row?.max_runs ?? null };
  }

  setPrefs(runDays: number | null, maxRuns: number | null): void {
    this.ensureSchema();
    if (runDays !== null && (!Number.isInteger(runDays) || runDays < 1)) throw new Error('run_days must be a positive integer or null');
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) throw new Error('max_runs must be a positive integer or null');
    this.db.prepare('UPDATE retention_prefs SET run_days=?, max_runs=? WHERE id=1').run(runDays, maxRuns);
  }

  /** Prune terminal runs outside the retention window / per-task cap. Returns deleted count. */
  sweep(now = Date.now()): number {
    this.ensureSchema();
    const { runDays, maxRuns } = this.getPrefs();
    let deleted = 0;

    // Window-based: only terminal runs are ever pruned.
    if (runDays !== null) {
      const cutoff = now - runDays * 86_400_000;
      const info = this.db
        .prepare(
          `DELETE FROM runs WHERE state IN ('completed','failed','timed_out','skipped','cancelled') AND COALESCE(ended_at, scheduled_for) < ?`,
        )
        .run(cutoff);
      deleted += Number(info.changes ?? 0);
    }

    // Cap-based: keep the N most recent terminal runs per task.
    if (maxRuns !== null) {
      const info = this.db
        .prepare(
          `DELETE FROM runs WHERE state IN ('completed','failed','timed_out','skipped','cancelled') AND id IN (
             SELECT r.id FROM runs r
             JOIN tasks t ON t.id = r.task_id
             WHERE r.state IN ('completed','failed','timed_out','skipped','cancelled') AND t.deleted_at IS NULL
             ORDER BY t.id, COALESCE(r.ended_at, r.scheduled_for) DESC
           ) AND (
             SELECT COUNT(*) FROM runs r2
             WHERE r2.task_id = runs.task_id AND r2.state IN ('completed','failed','timed_out','skipped','cancelled')
               AND COALESCE(r2.ended_at, r2.scheduled_for) > COALESCE(runs.ended_at, runs.scheduled_for)
           ) >= ?`,
        )
        .run(maxRuns);
      deleted += Number(info.changes ?? 0);
    }

    // Trigger event log (goal #27): raw inbound payloads grow unboundedly and
    // may embed third-party data — prune with the same window as runs.
    if (runDays !== null) {
      const cutoff = now - runDays * 86_400_000;
      const info = this.db
        .prepare('DELETE FROM trigger_events WHERE at < ?')
        .run(cutoff);
      deleted += Number(info.changes ?? 0);
    }
    return deleted;
  }

  // ---- audit log ----

  log(entry: AuditEntry): void {
    this.ensureSchema();
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.at ?? Date.now(), entry.actor ?? 'local', entry.action, entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.detail ?? {}));
  }

  list(limit = 200, offset = 0): Array<Record<string, unknown>> {
    this.ensureSchema();
    return this.db
      .prepare('SELECT at, actor, action, target_type, target_id, detail_json FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as Array<Record<string, unknown>>;
  }
}
