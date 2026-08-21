-- 0001 — normative DDL from plan/02-architecture.md §1 (verbatim shape)

CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL, color TEXT, avatar TEXT,
  engine        TEXT NOT NULL DEFAULT 'cli',
  model         TEXT, permission_mode TEXT,
  budget_usd    REAL, max_turns INTEGER, timeout_sec INTEGER,
  skills_json   TEXT NOT NULL DEFAULT '[]',
  mcp_allow_json TEXT NOT NULL DEFAULT '[]',
  context_roots_json TEXT NOT NULL DEFAULT '[]',
  system_prompt_extra TEXT,
  delivery_json TEXT,
  builtin       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  profile_id    TEXT REFERENCES profiles(id),
  repo_path     TEXT,
  model         TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  budget_usd    REAL NOT NULL DEFAULT 2.0,
  max_turns     INTEGER NOT NULL DEFAULT 50,
  timeout_sec   INTEGER NOT NULL DEFAULT 3600,
  base_branch   TEXT,
  context_json  TEXT NOT NULL DEFAULT '[]',
  delivery_json TEXT NOT NULL DEFAULT '{}',
  missed_policy TEXT NOT NULL DEFAULT 'run-late',
  missed_window_sec INTEGER NOT NULL DEFAULT 21600,
  overlap_policy TEXT NOT NULL DEFAULT 'skip',
  retry_on_transient INTEGER NOT NULL DEFAULT 0,
  flexible      INTEGER NOT NULL DEFAULT 0,
  chain_after   TEXT REFERENCES tasks(id),
  chain_on      TEXT DEFAULT 'success',
  template_id   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 1,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  rrule      TEXT,
  cron       TEXT,
  run_at     INTEGER,
  tz         TEXT NOT NULL,
  next_fire  INTEGER,
  enabled    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_schedules_next ON schedules(enabled, next_fire);

CREATE TABLE schedule_occurrences (
  schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_at INTEGER NOT NULL,
  run_id        TEXT,
  disposition   TEXT NOT NULL,
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, occurrence_at)
);

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  occurrence_at INTEGER,
  schedule_id  TEXT,
  jobspec_json TEXT NOT NULL,
  state        TEXT NOT NULL,
  state_changed_at INTEGER NOT NULL,
  worktree_path TEXT, branch TEXT,
  session_id   TEXT,
  pid          INTEGER, pgid INTEGER, proc_started_at INTEGER,
  journal_path TEXT,
  transcript_path TEXT,
  heartbeat_at INTEGER,
  cost_usd     REAL DEFAULT 0, turns INTEGER DEFAULT 0,
  started_at   INTEGER, ended_at INTEGER,
  scheduled_for INTEGER,
  outcome_reason TEXT,
  worktree_pruned INTEGER NOT NULL DEFAULT 0,
  report_json  TEXT
);
CREATE INDEX idx_runs_state ON runs(state);
CREATE INDEX idx_runs_task_time ON runs(task_id, scheduled_for);

CREATE TABLE approvals (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  responded_at INTEGER, response_json TEXT,
  timeout_at INTEGER NOT NULL, fallback TEXT NOT NULL
);

CREATE TABLE capacity_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, window_kind TEXT, used_pct REAL, source TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, run_id TEXT, kind TEXT NOT NULL, data_json TEXT
);

CREATE TABLE task_failure_streaks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE search_idx USING fts5(
  kind,
  ref_id UNINDEXED,
  title, body,
  tokenize='porter unicode61'
);
