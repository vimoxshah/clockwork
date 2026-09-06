-- 0008_agent_workforce.sql — the Agent Workforce foundation.
--
-- ONE forward-only migration carrying every table and column the twelve
-- workforce features need. Nothing here is wired yet: each feature lands in
-- the next wave as its own daemon module (see plan/AGENT-WORKFORCE-SPEC.md).
-- The schema ships first so twelve independent agents can build against a
-- frozen contract instead of racing each other for migration 0008.
--
-- FOREIGN-KEY RULE used throughout (foreign_keys = ON at open, db.ts:19):
--   * STRUCTURAL ownership -> inline FK with ON DELETE CASCADE. The child row
--     is meaningless without the parent, and the cascade is what keeps the
--     retention sweep working: retention-audit.ts sweep() runs a bare
--     `DELETE FROM runs ...`, so any un-cascaded FK to runs(id) would abort it.
--   * INFORMATIONAL back-reference -> plain nullable TEXT, no FK. Precedent:
--     trigger_events.run_id / trigger_id (0005) point at rows that may be
--     pruned underneath them and must not block the delete.
--
-- Timestamps are INTEGER epoch MILLISECONDS supplied by the application
-- (Date.now()); created_at/updated_at carry no SQL default, matching 0001.
-- Business ids are ULIDs from newId() (packages/shared/src/ids.ts).

-- ---------------------------------------------------------------------------
-- Cross-feature settings (singleton, retention_prefs pattern from 0004).
-- Holds the knobs three features share so they cannot drift apart:
-- office-hours on/off, the acceptance streak earned-autonomy requires, the
-- consecutive-failure count that books a self-healing diagnostic, and the
-- human hourly rate timesheets compare an agent's effective rate against.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workforce_prefs (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  office_hours_enabled        INTEGER NOT NULL DEFAULT 0,
  autonomy_streak_required    INTEGER NOT NULL DEFAULT 5,
  self_heal_failure_threshold INTEGER NOT NULL DEFAULT 3,
  human_hourly_rate_usd       REAL,               -- NULL = no comparison rate set
  review_period_days          INTEGER NOT NULL DEFAULT 30
);
INSERT OR IGNORE INTO workforce_prefs
  (id, office_hours_enabled, autonomy_streak_required, self_heal_failure_threshold, human_hourly_rate_usd, review_period_days)
  VALUES (1, 0, 5, 3, NULL, 30);

-- ---------------------------------------------------------------------------
-- F1 plan-then-execute: the gate ledger for one booking that becomes two runs.
--
-- Why a table and not just chain_after: chain firing is ONE-SHOT at the
-- upstream run's terminal state and filters `enabled = 1`
-- (run-manager.ts:603). The execute half must stay disabled until a human
-- approves the plan, which happens AFTER the plan run has already ended — so
-- the chain can never carry it. This row is the durable gate that survives
-- the gap between "plan run finished" and "human approved".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_execute_pairs (
  id              TEXT PRIMARY KEY,
  plan_task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execute_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_run_id     TEXT,                             -- informational
  approval_id     TEXT,                             -- informational (approvals.id)
  execute_run_id  TEXT,                             -- informational
  status          TEXT NOT NULL DEFAULT 'awaiting_plan',
                  -- 'awaiting_plan' | 'awaiting_approval' | 'approved' | 'rejected' | 'executed'
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_execute_pairs_plan ON plan_execute_pairs(plan_task_id);
CREATE INDEX IF NOT EXISTS idx_plan_execute_pairs_status ON plan_execute_pairs(status);

-- ---------------------------------------------------------------------------
-- F2 shift-handoff (and the sink for F6 accept-with-note).
-- One append-only memory per task: what the last shift tried, what blocked it,
-- what to check next. The agent writes 'handoff' rows at run end; the human
-- writes 'note' rows from the inbox. Both are read at the next run's start,
-- which is why they share one table instead of drifting as two.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_memories (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id     TEXT,                                  -- informational
  author     TEXT NOT NULL DEFAULT 'agent',         -- 'agent' | 'human'
  kind       TEXT NOT NULL DEFAULT 'handoff',       -- 'handoff' | 'note'
  tried      TEXT,
  blocked    TEXT,
  next_check TEXT,
  body       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_task ON agent_memories(task_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- F3 office-hours: windows in which the human can answer an approval.
-- No midnight wrap — a window that crosses midnight is stored as two rows, so
-- every shift computation is a simple [start_min, end_min) containment test.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS office_hours (
  id         TEXT PRIMARY KEY,
  label      TEXT,
  dow        INTEGER NOT NULL,                      -- 0=Sunday .. 6=Saturday
  start_min  INTEGER NOT NULL,                      -- minutes past local midnight, inclusive
  end_min    INTEGER NOT NULL,                      -- exclusive; must exceed start_min
  tz         TEXT NOT NULL,                         -- IANA zone, e.g. 'America/New_York'
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_office_hours_dow ON office_hours(enabled, dow);

-- ---------------------------------------------------------------------------
-- F4 sentinel-worker: a cheap sentinel task on a tight cadence books a full
-- worker run when its condition trips. The booking goes through an EXISTING
-- trigger (0005) so the policy gate, the inbound event log and run creation
-- all come for free — hence trigger_id, not worker_task_id. The worker task is
-- reachable as triggers.task_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sentinels (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  sentinel_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger_id       TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  trip_expr        TEXT NOT NULL,                   -- marker the sentinel report must contain
  cooldown_sec     INTEGER NOT NULL DEFAULT 3600,   -- suppress re-booking inside this window
  last_tripped_at  INTEGER,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentinels_task ON sentinels(sentinel_task_id);

-- Every evaluation, tripped or not — the observability half, mirroring
-- trigger_events. A non-trip is as diagnostic as a trip.
CREATE TABLE IF NOT EXISTS sentinel_trips (
  id            TEXT PRIMARY KEY,
  sentinel_id   TEXT NOT NULL REFERENCES sentinels(id) ON DELETE CASCADE,
  run_id        TEXT,                               -- sentinel run evaluated (informational)
  worker_run_id TEXT,                               -- run booked via the trigger (informational)
  tripped       INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,                               -- why it did NOT book (cooldown/no match/disabled)
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentinel_trips_at ON sentinel_trips(at DESC);

-- ---------------------------------------------------------------------------
-- F5 repo-shipped-jobs: a .clockwork/jobs.yaml inside a target repo declares
-- recommended jobs. Clockwork DISCOVERS and OFFERS them; it never imports one
-- on its own. An accepted offer arrives DISABLED with a security preview,
-- exactly like template import (S-74) — preview_json holds that preview so the
-- user sees the same flags at review time that were computed at discovery.
-- digest is the sha256 of spec_json: when the repo file changes, the digest
-- changes and the offer is re-presented rather than silently updated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_jobs (
  id            TEXT PRIMARY KEY,
  repo_path     TEXT NOT NULL,
  source_path   TEXT NOT NULL,                      -- absolute path of the jobs file read
  job_key       TEXT NOT NULL,                      -- author-declared key, unique within the repo
  name          TEXT NOT NULL,
  spec_json     TEXT NOT NULL,                      -- the declared job, normalized
  digest        TEXT NOT NULL,                      -- sha256 of spec_json
  preview_json  TEXT,                               -- securityPreview() flags at discovery
  status        TEXT NOT NULL DEFAULT 'offered',    -- 'offered' | 'imported' | 'dismissed'
  task_id       TEXT,                               -- informational; set on import
  discovered_at INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_jobs_key ON repo_jobs(repo_path, job_key);
CREATE INDEX IF NOT EXISTS idx_repo_jobs_status ON repo_jobs(status);

-- ---------------------------------------------------------------------------
-- F6 accept-with-note: THE acceptance signal, and the north-star metric's
-- source of truth. One decision per run (run_id is the PK, so a second accept
-- is an update, never a duplicate). CASCADE on runs(id) keeps the retention
-- sweep's `DELETE FROM runs` working.
--
-- profile_id is a nullable snapshot with no FK: it records which agent earned
-- the acceptance even if that profile is later deleted, and F10/F11 read it
-- for live rows while falling back to json_extract(runs.jobspec_json,
-- '$.profile.id') for runs decided before this table existed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_outcomes (
  run_id     TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_id TEXT,                                  -- informational snapshot
  decision   TEXT NOT NULL,                         -- 'accepted' | 'accepted_with_note' | 'rejected'
  note       TEXT,
  memory_id  TEXT,                                  -- agent_memories row holding the note (F2)
  actor      TEXT NOT NULL DEFAULT 'local',
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_outcomes_task ON run_outcomes(task_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_outcomes_profile ON run_outcomes(profile_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- F7 earned-autonomy: the next rung is OFFERED, never auto-granted. This table
-- is the offer ledger; the grant itself is a human PATCH of the profile's
-- autonomy_rung. A declined offer stays on the record so the streak that
-- produced it is not silently re-offered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS autonomy_offers (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_rung  TEXT NOT NULL,                         -- 'plan' | 'acceptEdits'
  to_rung    TEXT NOT NULL,                         -- 'acceptEdits' | 'unattended'
  streak     INTEGER NOT NULL,                      -- accepted-in-a-row that earned the offer
  status     TEXT NOT NULL DEFAULT 'offered',       -- 'offered' | 'accepted' | 'declined'
  offered_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_autonomy_offers_profile ON autonomy_offers(profile_id, offered_at DESC);

-- ---------------------------------------------------------------------------
-- F8 self-healing: a diagnostic run's output becomes an APPROVAL ITEM
-- proposing a prompt or profile diff. A human applies it. The agent never
-- edits its own prompt — which is why proposed_value sits here in a row with a
-- status, and nothing in this migration writes back to tasks.prompt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remediation_proposals (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id         TEXT,                              -- diagnostic run (informational)
  approval_id    TEXT,                              -- inbox approval (informational)
  target         TEXT NOT NULL,                     -- 'prompt' | 'profile'
  current_value  TEXT,                              -- snapshot at proposal time
  proposed_value TEXT NOT NULL,
  rationale      TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed',  -- 'proposed' | 'applied' | 'rejected'
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_remediation_proposals_task ON remediation_proposals(task_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Column additions. Every one is nullable or NOT NULL + DEFAULT, because
-- SQLite cannot add a NOT NULL column without a default and ADD COLUMN has no
-- IF NOT EXISTS (so this migration is not re-runnable — it does not need to
-- be; schema_migrations records it once).
-- ---------------------------------------------------------------------------

-- F3: only profiles flagged here have their next_fire shifted into office
-- hours. Default 0 means every profile that exists today is untouched.
ALTER TABLE profiles ADD COLUMN may_require_approval INTEGER NOT NULL DEFAULT 0;

-- F7: NULL = not enrolled in earned autonomy. Deliberately NOT defaulted to
-- 'plan' — every existing profile runs acceptEdits today, and stamping them
-- 'plan' would misreport a rung nobody chose.
ALTER TABLE profiles ADD COLUMN autonomy_rung TEXT;              -- 'plan' | 'acceptEdits' | 'unattended'
ALTER TABLE profiles ADD COLUMN autonomy_streak_required INTEGER; -- NULL = use workforce_prefs

-- F1: which half of a plan/execute pair this task is. NULL = an ordinary task.
ALTER TABLE tasks ADD COLUMN plan_stage TEXT;                    -- 'plan' | 'execute'

-- F8: extends the EXISTING consecutive-failure counter (policies.ts) rather
-- than adding a second failure table. These record the diagnostic already
-- booked for the current streak, so one streak books one diagnostic.
ALTER TABLE task_failure_streaks ADD COLUMN diagnostic_run_id TEXT;
ALTER TABLE task_failure_streaks ADD COLUMN diagnostic_at INTEGER;
