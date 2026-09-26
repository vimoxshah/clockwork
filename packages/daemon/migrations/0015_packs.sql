-- P6 template packs: what is installed, from where, and which tasks came from it.
-- installed_packs tracks pack name → version for update detection ("already
-- installed", "update available" by re-fetching the same source). Updates
-- never replace in place: new tasks arrive disabled like first installs, and
-- the old ones stay until the user removes them — a pack update must not
-- silently rewrite a working routine.
CREATE TABLE IF NOT EXISTS installed_packs (
  name       TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  publisher  TEXT NOT NULL DEFAULT '',
  source     TEXT,
  key_id     TEXT,
  installed_at INTEGER NOT NULL
);

-- Tasks created by a pack install, for honest uninstall: only tasks that are
-- still disabled and never ran are removed; anything the user enabled or ran
-- is theirs now and stays, reported as kept.
CREATE TABLE IF NOT EXISTS installed_pack_tasks (
  pack_name TEXT NOT NULL REFERENCES installed_packs(name) ON DELETE CASCADE,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (pack_name, task_id)
);
