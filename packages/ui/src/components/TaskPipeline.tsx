/**
 * Pipelines section (P3): pick a task, see its chain graph, manage parents.
 *
 * Rendered as nested upstream/downstream lists, not SVG art: the graph's job
 * is to answer "what runs before this, what runs after, and what state is
 * each in" — indentation answers that without a layout engine. Clicking a
 * node shows its latest run (state, cost, turns) plus the edge conditions
 * into it, with Run now (retry), Run pipeline (run-now every root), and
 * parent add/remove beside it.
 *
 * States come straight from GET /tasks/:id/pipeline's derived field:
 * succeeded | failed | skipped | running | waiting | blocked.
 */
import { useMemo, useState } from 'react';
import { api, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';

// No registerFeatureSurface here on purpose: 'agent_chains' is already
// registered by TasksView's Edit-task chain picker, and the surfaces map
// keeps one entry per key — registering again would repoint that tick at
// this section. This screen shares the capability; it does not re-declare it.

type PipeNode = {
  taskId: string;
  name: string;
  enabled: boolean;
  parents: Array<{ parentId: string; on: string; via: string }>;
  latestRun: { id: string; state: string; costUsd: number; turns: number } | null;
  derived: string;
};

const STATE_ICON: Record<string, string> = {
  succeeded: '✓',
  failed: '✗',
  skipped: '−',
  running: '●',
  waiting: '○',
  blocked: '■',
};

function iconFor(derived: string): string {
  return STATE_ICON[derived] ?? '?';
}

export function PipelinesSection({ version, tasks }: { version: number; tasks: TaskViewT[] }): JSX.Element {
  const [focusId, setFocusId] = useState<string | null>(tasks[0]?.id ?? null);
  const focus = tasks.find((t) => t.id === focusId) ?? tasks[0] ?? null;
  return (
    <div data-testid="pipelines-section">
      <p className="hint" style={{ marginTop: 0 }}>
        Chains that fan out and back in. A stage fires when <em>all</em> its parents satisfy their edge —
        linear <span className="mono">chain_after</span> links keep their fire-on-one-upstream behavior.
      </p>
      <label className="f" htmlFor="pipeline-focus">
        Pipeline around
      </label>
      <select
        id="pipeline-focus"
        data-testid="pipeline-focus"
        className="cred-field"
        value={focus?.id ?? ''}
        onChange={(e) => setFocusId(e.target.value || null)}
      >
        {(tasks ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {focus && <TaskPipeline key={focus.id} taskId={focus.id} taskName={focus.name} tasks={tasks} version={version} />}
    </div>
  );
}

export function TaskPipeline({
  taskId,
  tasks,
  version,
}: {
  taskId: string;
  taskName: string;
  tasks: TaskViewT[];
  version: number;
}): JSX.Element {
  const pipe = useAsync(() => api.pipeline(taskId), [taskId, version]);
  // Selected defaults to the focus task (this component remounts per task via
  // key=): a chain-less focus then shows its own detail box — including the
  // add-parent form — instead of a hint pointing at controls that never render.
  const [selected, setSelected] = useState<string | null>(taskId);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newParent, setNewParent] = useState('');
  const [newOn, setNewOn] = useState('completed');

  const nodes = useMemo(() => pipe.data?.nodes ?? [], [pipe.data]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.taskId, n])), [nodes]);
  const focus = byId.get(taskId);
  const upstream = useMemo(() => nodes.filter((n) => n.taskId !== taskId && isAncestor(byId, n.taskId, taskId)), [nodes, byId, taskId]);
  const downstream = useMemo(() => nodes.filter((n) => n.taskId !== taskId && isAncestor(byId, taskId, n.taskId)), [nodes, byId, taskId]);
  const roots = useMemo(() => nodes.filter((n) => n.parents.length === 0), [nodes]);
  const sel = selected ? byId.get(selected) ?? null : null;

  const act = async (fn: () => Promise<unknown>, okMsg: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await fn();
      setMsg(okMsg);
      pipe.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pipe.loading) return <p className="hint">Loading pipeline…</p>;
  if (pipe.error) return <div className="error-banner" role="alert">Couldn’t load the pipeline: {pipe.error}</div>;
  if (!focus) return <p className="hint">This task is in no chain — add a parent below to start one.</p>;

  const candidates = tasks.filter((t) => t.id !== taskId && !focus.parents.some((p) => p.parentId === t.id));

  return (
    <div className="mt-3" data-testid="task-pipeline">
      {upstream.length > 0 && (
        <div className="mb-2">
          <div className="f">Upstream</div>
          {upstream.map((n) => (
            <NodeRow key={n.taskId} node={n} selected={selected === n.taskId} onSelect={() => setSelected(n.taskId)} />
          ))}
        </div>
      )}
      <div className="mb-2">
        <div className="f">This stage</div>
        <NodeRow node={focus} selected={selected === focus.taskId} onSelect={() => setSelected(focus.taskId)} focus />
      </div>
      {downstream.length > 0 && (
        <div className="mb-2">
          <div className="f">Downstream</div>
          {downstream.map((n) => (
            <NodeRow key={n.taskId} node={n} selected={selected === n.taskId} onSelect={() => setSelected(n.taskId)} />
          ))}
        </div>
      )}
      {sel && (
        <div className="mt-2 rounded-lg border border-border bg-bg p-3" data-testid="pipeline-node-detail">
          <strong>
            {iconFor(sel.derived)} {sel.name}
          </strong>{' '}
          <span className="chip">{sel.derived}</span>
          {!sel.enabled && <span className="chip failed">paused</span>}
          <div className="hint" style={{ margin: '6px 0' }}>
            {sel.latestRun
              ? `Latest run ${sel.latestRun.state} · $${sel.latestRun.costUsd.toFixed(2)} · ${sel.latestRun.turns} turns`
              : 'No runs yet.'}
            {sel.parents.length > 0 && (
              <>
                {' '}Waits on{' '}
                {sel.parents.map((p) => `${byId.get(p.parentId)?.name ?? p.parentId} (${p.on}${p.via === 'edge' ? '' : ', chained'})`).join(', ')}.
              </>
            )}
          </div>
          <div className="cred-actions">
            <button className="btn small" disabled={busy} onClick={() => void act(() => api.runNow(sel.taskId), `Run queued for “${sel.name}”.`)}>
              Run now
            </button>
          </div>
          {sel.taskId === taskId && (
            <div className="mt-2">
              <label className="f" htmlFor="pipeline-add-parent">
                Add upstream dependency
              </label>
              <div className="flex gap-2">
                <select
                  id="pipeline-add-parent"
                  data-testid="pipeline-add-parent"
                  className="cred-field"
                  value={newParent}
                  onChange={(e) => setNewParent(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">Pick a task…</option>
                  {candidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Edge condition"
                  data-testid="pipeline-add-on"
                  className="cred-field"
                  value={newOn}
                  onChange={(e) => setNewOn(e.target.value)}
                  style={{ width: 150 }}
                >
                  <option value="completed">on success</option>
                  <option value="any_terminal">on any end</option>
                </select>
                <button
                  className="btn small primary"
                  data-testid="pipeline-add-button"
                  disabled={busy || !newParent}
                  onClick={() =>
                    void act(() => api.addParent(taskId, newParent, newOn).then(() => setNewParent('')), 'Dependency added.')
                  }
                >
                  Add
                </button>
              </div>
              {focus.parents.length > 0 && (
                <div className="mt-2">
                  {focus.parents.map((p) => (
                    <div key={p.parentId} className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>
                        ← {byId.get(p.parentId)?.name ?? p.parentId} ({p.on}
                        {p.via === 'edge' ? '' : ', chained'})
                      </span>
                      {p.via === 'edge' && (
                        <button
                          className="btn small danger"
                          data-testid={`pipeline-remove-${p.parentId}`}
                          disabled={busy}
                          onClick={() => void act(() => api.removeParent(taskId, p.parentId), 'Dependency removed.')}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <p className="hint">Chained (`chain_after`) links are managed where they were made — only edge rows remove here.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {roots.length > 0 && (
        <div className="mt-2">
          <button
            className="btn small"
            data-testid="pipeline-run-roots"
            disabled={busy}
            onClick={() =>
              void act(
                () => Promise.all(roots.map((r) => api.runNow(r.taskId))).then(() => undefined),
                `Pipeline started — ${roots.length} root${roots.length === 1 ? '' : 's'} queued, the rest follows.`,
              )
            }
          >
            Run pipeline ({roots.length} root{roots.length === 1 ? '' : 's'})
          </button>
        </div>
      )}
      {msg && <div className="ok-banner">{msg}</div>}
      {err && (
        <div className="error-banner" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

function isAncestor(byId: Map<string, PipeNode>, maybeAncestor: string, taskId: string): boolean {
  if (maybeAncestor === taskId) return false;
  const seen = new Set<string>([taskId]);
  const stack = (byId.get(taskId)?.parents ?? []).map((p) => p.parentId);
  for (let i = 0; i < 1000 && stack.length > 0; i++) {
    const cur = stack.pop()!;
    if (cur === maybeAncestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of byId.get(cur)?.parents ?? []) stack.push(p.parentId);
  }
  return false;
}

function NodeRow({ node, selected, onSelect, focus }: { node: PipeNode; selected: boolean; onSelect: () => void; focus?: boolean }): JSX.Element {
  return (
    <button
      className="day-list-row"
      data-testid={`pipeline-node-${node.taskId}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={focus ? { fontWeight: 700 } : undefined}
    >
      <span className="mono" aria-hidden="true">
        {iconFor(node.derived)}
      </span>{' '}
      <span className="day-list-name" title={node.name}>
        {node.name}
      </span>{' '}
      <span className="chip">{node.derived}</span>
      {!node.enabled && <span className="chip failed">paused</span>}
    </button>
  );
}
