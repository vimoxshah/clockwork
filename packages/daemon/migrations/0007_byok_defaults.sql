-- Commercial BYOK (gauntlet): explicit default-provider flag and a cached
-- friendly model label ("Claude Sonnet") alongside the raw model id.
ALTER TABLE byok_configs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE byok_configs ADD COLUMN model_label TEXT;
