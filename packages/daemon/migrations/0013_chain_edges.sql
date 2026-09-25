-- P3 chaining v2: DAG edges beside the legacy single chain_after column.
-- A row is one dependency: child fires when ALL its parents satisfy their
-- edge condition (checked at each parent's completion). chain_after rows keep
-- their legacy fire-on-this-upstream semantics untouched — the union is read
-- at fire time, never migrated.
CREATE TABLE IF NOT EXISTS chain_edges (
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  on_state       TEXT NOT NULL DEFAULT 'completed' CHECK (on_state IN ('completed', 'any_terminal')),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (parent_task_id, child_task_id)
);
CREATE INDEX IF NOT EXISTS idx_chain_edges_child ON chain_edges(child_task_id);
CREATE INDEX IF NOT EXISTS idx_chain_edges_parent ON chain_edges(parent_task_id);
