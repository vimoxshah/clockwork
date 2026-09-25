# Chaining: linear links and DAG pipelines

Two mechanisms, one firing engine. Linear `chain_after` links keep their
shipped semantics; `chain_edges` rows add fan-out/fan-in on top. The union is
read at fire time — nothing is migrated, and removing an edge never touches
the column.

## The two semantics (deliberately different)

- **Column (`chain_after`)**: fires on *this* upstream's trigger state alone.
  A fan-in through the column fires on the first completing parent, not when
  all are ready. Unchanged since H1 — workflows built on it keep working.
- **Edges (`chain_edges`)**: the child fires only when *all* its parents
  (edge parents plus a legacy parent, if any) satisfy their own edge
  condition, and only when the child has no active run. A retried parent that
  completes again re-fires an idle child with the fresh output.

Edge conditions: `completed` (plus `budget_exceeded`, which counts as a
usable finish everywhere chains run) or `any_terminal`.

## Placeholders

- `{{previous.report}}` / `{{previous.artifacts}}` — the completing run.
  Unchanged, 12k budget, same truncation note.
- `{{runs.<taskId>.report}}` / `{{runs.<taskId>.artifacts}}` — that parent's
  latest run at fire time, so a retried parent re-binds instead of replaying
  stale output. Unknown ids and parents with no runs yet **refuse the firing**
  (`chain_skipped` naming the id) instead of rendering into instructions.

## When a child does not fire

- `chain_waiting`: some parent has no runs yet — patience, not failure.
- `chain_skipped`: a gate failed, the child is already active (no
  double-fire), or a placeholder reference is unresolvable. The event names
  which.
- A missing repo on the successor fails the *upstream* run loudly
  (`chain_preflight`) rather than half-firing. Same as linear chains always did.

## The pipeline view

Tasks › Pipelines shows ancestors and descendants of a focus task with
per-node states (`succeeded | failed | skipped | running | waiting |
blocked`), the edge condition into each node, node click-through to the
latest run, per-node Run now (retry), Run-pipeline (run-now every root —
downstream follows through firing), and parent add/remove. Edge rows remove
here; `chain_after` links are edited where they were made.

## Honest limits

- Fan-in waits for parents with runs; a parent that never runs holds the
  child at `blocked` forever — the panel shows which one, it does not nudge it.
- `chain_on: 'success'` on old rows means `completed` (normalized at read).
- Pipeline graph is capped at 100 nodes and 6 levels each way.
- Multi-machine workers (P4) do not change firing: a stage runs wherever the
  scheduler puts it.
