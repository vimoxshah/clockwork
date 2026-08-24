-- Event triggers (goal #27): inbound events fire tasks.
CREATE TABLE IF NOT EXISTS triggers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source      TEXT NOT NULL,               -- 'webhook' | 'github'
  filter_json TEXT,                        -- dot-path match rules (nullable = match all)
  secret_hash TEXT,                        -- sha256 of shared secret; NULL = unauthenticated
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_task ON triggers(task_id);

-- Inbound event log: every received event, matched or not (observability).
CREATE TABLE IF NOT EXISTS trigger_events (
  id          TEXT PRIMARY KEY,
  trigger_id  TEXT,
  source      TEXT NOT NULL,
  payload     TEXT NOT NULL,               -- raw JSON body (credential-free by contract)
  matched     INTEGER NOT NULL,            -- 1 if a trigger fired
  run_id      TEXT,                        -- set when fired
  note        TEXT,                        -- why it did NOT fire (signature/filter/disabled)
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigger_events_at ON trigger_events(at DESC);
