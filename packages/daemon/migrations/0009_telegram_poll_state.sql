-- Reachable approvals (inbound half, ADR-036): persist the Telegram
-- getUpdates offset so a daemon restart never re-delivers (and thus never
-- re-processes) a callback_query the poller already consumed. Single row by
-- construction (id is pinned to 1).
--
-- Numbering note: 0008 is already used by another in-flight branch
-- (0008_agent_workforce.sql) for an unrelated feature. The migration runner
-- (packages/daemon/src/db.ts loadMigrationsFrom / main.ts) only filename-sorts
-- and tracks applied ids in `schema_migrations` — it does not require
-- contiguous numbers — so this file takes 0009 to avoid a collision when the
-- branches merge, leaving a harmless gap at 0008 on this branch.
CREATE TABLE telegram_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  "offset" INTEGER NOT NULL
);
