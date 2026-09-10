-- T1-18. `RunRepo.list` ordered by COALESCE(scheduled_for, state_changed_at),
-- which no index can serve: a COALESCE over two columns is not sargable, so
-- idx_runs_task_time was never used for it and every /runs call sorted the
-- whole table. The ordering is now plain `state_changed_at DESC`.
--
-- Two indexes, because the query has two shapes. The unfiltered list (the
-- inbox, the tray, the digest) needs time alone. The per-task list needs the
-- filter and the sort together, or SQLite filters by task and then re-sorts.
CREATE INDEX IF NOT EXISTS idx_runs_time ON runs(state_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task_changed ON runs(task_id, state_changed_at DESC);
