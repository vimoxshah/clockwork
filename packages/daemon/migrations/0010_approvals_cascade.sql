-- 0010_approvals_cascade.sql — retention sweep atomicity fix.
--
-- Bug (verified against a live daemon): `approvals.run_id TEXT NOT NULL
-- REFERENCES runs(id)` (0001_init.sql) has no ON DELETE action. With
-- `foreign_keys = ON` (db.ts), retention-audit.ts sweep()'s bare
-- `DELETE FROM runs ...` aborts the ENTIRE statement (SQLite's default
-- FK-violation behavior rolls back the whole statement, not just the
-- offending row) the instant a single approvals row points at a run in the
-- delete set — pruning nothing, daemon-wide, forever, from the moment a user
-- answers their first approval.
--
-- This is exactly the FOREIGN-KEY RULE 0008's header already documents and
-- already applies to run_outcomes/autonomy_decisions:
--   "STRUCTURAL ownership -> inline FK with ON DELETE CASCADE. The child row
--    is meaningless without the parent, and the cascade is what keeps the
--    retention sweep working: retention-audit.ts sweep() runs a bare
--    `DELETE FROM runs ...`, so any un-cascaded FK to runs(id) would abort
--    it."
-- `approvals.run_id` predates that rule (0001) and was simply never brought
-- into line with it. This migration does that, for consistency with the
-- rest of the schema rather than inventing a second mechanism (deleting
-- dependents by hand inside the sweep) for the same category of problem.
--
-- SQLite cannot ALTER a column's REFERENCES/ON DELETE clause in place, so the
-- table is rebuilt via the standard 12-step recipe: copy rows into a new
-- table with the corrected FK, drop the old table, rename. `approvals` has no
-- indexes or triggers of its own to recreate, and no other table holds a hard
-- FK to approvals(id) (plan_execute_pairs.approval_id is informational TEXT,
-- per 0008's own rule), so the rebuild is a straight swap.
CREATE TABLE approvals_new (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  responded_at INTEGER, response_json TEXT,
  timeout_at INTEGER NOT NULL, fallback TEXT NOT NULL
);

INSERT INTO approvals_new (id, run_id, kind, payload_json, requested_at, responded_at, response_json, timeout_at, fallback)
  SELECT id, run_id, kind, payload_json, requested_at, responded_at, response_json, timeout_at, fallback FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
