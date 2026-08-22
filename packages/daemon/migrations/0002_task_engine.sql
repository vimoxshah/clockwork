-- 0002 — per-task execution provider (ADR-026): engine on tasks overrides profile default.
ALTER TABLE tasks ADD COLUMN engine TEXT;
