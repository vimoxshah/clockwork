-- 0003_byok.sql — BYOK provider configs (ADR-027) + task→byok binding.
-- Credential values NEVER live here; only keychain metadata (hint) and mode.
CREATE TABLE IF NOT EXISTS byok_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  auth TEXT NOT NULL DEFAULT 'keychain',
  hint TEXT,
  env_var TEXT,
  default_model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  last_error TEXT
);

ALTER TABLE tasks ADD COLUMN byok_id TEXT;
