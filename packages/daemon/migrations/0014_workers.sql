-- P4 multi-machine workers: registry, task pins, run assignment.
-- A worker is another Clockwork daemon (Mini/homelab) that pulls jobspecs and
-- executes them under its own sandbox. The primary never executes for a
-- worker; it assigns, receives results, and notices silence.
--
-- Deliberately NO new run states (the FSM in states.ts stays untouched):
-- assignment is timestamps on the existing queued row. Pump skips any row
-- with worker_id set; the worker pulls it through the protocol.
CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  pubkey_hash   TEXT NOT NULL,             -- sha256 of the worker's ed25519 pubkey (DER hex)
  platform      TEXT,                      -- free text from the worker ("darwin arm64")
  capabilities  TEXT NOT NULL DEFAULT '{}',
  token_hash    TEXT,                      -- sha256 of the worker bearer token; NULL until approved
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paired','revoked')),
  claimed_at    INTEGER,                   -- signature verified; still needs human approve
  online        INTEGER NOT NULL DEFAULT 0,
  last_heartbeat INTEGER,
  created_at    INTEGER NOT NULL
);

-- Task routing pins. NULL = run locally. required=1 waits for the worker;
-- required=0 falls back to local execution with a note when it is offline.
-- Pins null out when their worker is removed: a deleted worker must never
-- strand a task on an unroutable pin.
ALTER TABLE tasks ADD COLUMN worker_pin TEXT REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN worker_required INTEGER NOT NULL DEFAULT 0;

-- Which worker owns a run, if any, and whether it pulled the job yet.
ALTER TABLE runs ADD COLUMN worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN worker_claimed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_runs_worker ON runs(worker_id, state);
