-- 0004_retention_audit.sql — retention controls (goal #41) + audit log (goal #40).

-- Retention policy: single-row prefs style; days NULL = keep forever.
CREATE TABLE IF NOT EXISTS retention_prefs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_days INTEGER,             -- prune runs older than N days
  max_runs INTEGER              -- ...or keep at most N most-recent runs per task
);
INSERT OR IGNORE INTO retention_prefs (id, run_days, max_runs) VALUES (1, 90, 1000);

-- Audit log: append-only record of control-plane actions (enterprise goal #40).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'local',        -- 'local' | future auth identities
  action TEXT NOT NULL,                       -- e.g. 'task.create', 'run.cancel'
  target_type TEXT,                           -- 'task' | 'run' | 'byok' | 'profile' | 'settings'
  target_id TEXT,
  detail_json TEXT                            -- provider/model/execution-target/result snapshot
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
