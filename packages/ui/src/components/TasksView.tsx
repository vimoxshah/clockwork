/**
 * Tasks (FR-5/FR-6): first-class task management surface.
 * Full-width layout, instant multi-field search (name / prompt / repo /
 * provider), status filters, windowed rendering for 500+ tasks.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';

type StatusFilter = 'all' | 'active' | 'paused';
type SortKey = 'name' | 'recent';

/** Windowed rendering: only a slice of rows mounts at once (5k+ tasks stay smooth). */
const PAGE_SIZE = 100;

export default function TasksView({ version }: { version: number }): JSX.Element {
  const tasks = useAsync(() => api.tasks(), [version]);
  const queue = useAsync(() => api.queue(), [version]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskViewT | null>(null);
  const [deleting, setDeleting] = useState<TaskViewT | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => setVisibleCount(PAGE_SIZE), [q, status, sort]);

  const filtered = useMemo(() => {
    let rows = [...(tasks.data ?? [])];
    if (status === 'active') rows = rows.filter((t) => t.enabled);
    else if (status === 'paused') rows = rows.filter((t) => !t.enabled);
    const term = q.trim().toLowerCase();
    if (term) {
      rows = rows.filter((t) =>
        t.name.toLowerCase().includes(term) ||
        t.prompt.toLowerCase().includes(term) ||
        (t.repoPath ?? '').toLowerCase().includes(term) ||
        String(t.engine ?? '').toLowerCase().includes(term));
    }
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else rows.sort((a, b) => String(b.id).localeCompare(String(a.id))); // ULID ids are time-ordered
    return rows;
  }, [tasks.data, q, status, sort]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
    setActionErr(null);
    try {
      await fn();
      if (okMsg) {
        setNotice(okMsg);
        setTimeout(() => setNotice(null), 4000);
      }
      tasks.reload();
      queue.reload();
    } catch (e) {
      setActionErr(String((e as Error).message ?? e));
    }
  };

  return (
    <div className="tasks-page">
      {/* ---- sticky toolbar: search drives everything ---- */}
      <div className="tasks-toolbar">
        <div className="relative" style={{ flex: 1, minWidth: 260 }}>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">🔍</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks by name, prompt, repo, or provider…"
            aria-label="Search tasks"
            data-testid="task-filter"
            className="inbox-search !pl-9"
            style={{ width: '100%' }}
            autoFocus
          />
          {q && (
            <button
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-dim hover:text-fg"
            >
              ✕
            </button>
          )}
        </div>
        <div className="seg" role="tablist" aria-label="Task status">
          {(['all', 'active', 'paused'] as StatusFilter[]).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort tasks"
          className="btn small"
          style={{ padding: '6px 10px' }}
        >
          <option value="recent">Newest first</option>
          <option value="name">Name A→Z</option>
        </select>
        <span className="chip" style={{ whiteSpace: 'nowrap' }} data-testid="task-count">
          {q.trim() || status !== 'all'
            ? `${filtered.length} of ${tasks.data?.length ?? 0}`
            : `${filtered.length} task${filtered.length === 1 ? '' : 's'}`}
        </span>
        <button className="btn small" onClick={() => { tasks.reload(); queue.reload(); }} aria-label="Refresh tasks">
          ⟳
        </button>
      </div>

      {notice && <div className="ok-banner">{notice}</div>}
      {actionErr && <div className="error-banner" role="alert">{actionErr}</div>}

      {/* ---- queue lane ---- */}
      {queue.data && queue.data.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="section-title">Queue — waiting to run</h3>
          {queue.error && <div className="error-banner">Couldn’t load queue: {queue.error}</div>}
          {queue.data.map((qi) => (
            <div key={qi.runId} className="tasklist-row" data-testid={`queue-${qi.position}`}>
              <span className="chip running">#{qi.position}</span>
              <div className="grow">
                <strong>{qi.name}</strong>
                <div className="hint" style={{ margin: 0 }}>{qi.reason}</div>
              </div>
              <button className="btn danger small" onClick={() => void act(() => api.cancelRun(qi.runId))}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- states ---- */}
      {tasks.loading && <div className="state-line"><span className="spinner" /> Loading tasks…</div>}
      {tasks.error && (
        <div className="error-banner" role="alert">
          Couldn’t load tasks: {tasks.error}
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={tasks.reload}>Retry</button></div>
        </div>
      )}
      {!tasks.loading && !tasks.error && (tasks.data ?? []).length === 0 && (
        <div className="empty">
          No tasks yet. Book your first run from the calendar or the “+ New task” tab.
        </div>
      )}
      {!tasks.loading && !tasks.error && (tasks.data ?? []).length > 0 && filtered.length === 0 && (
        <div className="empty">
          No tasks match “{q.trim()}”{status !== 'all' ? ` (${status})` : ''}.
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={() => { setQ(''); setStatus('all'); }}>Clear filters</button></div>
        </div>
      )}

      {/* ---- list ---- */}
      <div className="tasklist">
        {filtered.slice(0, visibleCount).map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            onRunNow={() => void act(() => api.runNow(t.id), `Run queued for “${t.name}” — watch the calendar or inbox.`)}
            onToggle={() => void act(() => api.patchTask(t.id, { enabled: !t.enabled, version: t.version }))}
            onEdit={() => setEditing(t)}
            onDelete={() => setDeleting(t)}
          />
        ))}
      </div>
      {visibleCount < filtered.length && (
        <button className="btn small" style={{ marginTop: 12 }} onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} data-testid="task-more">
          Show {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more ({filtered.length - visibleCount} hidden)
        </button>
      )}

      {editing && (
        <EditDialog
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg: string) => {
            setEditing(null);
            setNotice(msg);
            setTimeout(() => setNotice(null), 4000);
            tasks.reload();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="The task is soft-deleted: history and reports are kept, future occurrences stop immediately."
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteTask(deleting.id);
            setDeleting(null);
            tasks.reload();
          }}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  onRunNow,
  onToggle,
  onEdit,
  onDelete,
}: {
  task: TaskViewT;
  onRunNow: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="tasklist-row">
      <div className="grow">
        <strong>
          {task.name}{' '}
          {!task.enabled && <span className="chip failed">paused</span>}
        </strong>
        <div className="hint" style={{ margin: 0 }}>
          next {task.enabled ? (task.nextFire ? new Date(task.nextFire).toLocaleString() : '—') : '—'}
          {' · '}${task.budget.maxUsd} · {task.permissionMode}
          {task.repoPath ? ` · ${task.repoPath}` : ' · scratch'}
        </div>
      </div>
      <button className="btn primary small" onClick={onRunNow}>
        Run now
      </button>
      <button className="btn small" onClick={onToggle}>
        {task.enabled ? 'Pause' : 'Enable'}
      </button>
      <button className="btn small" onClick={onEdit}>
        Edit
      </button>
      <button className="btn danger small" onClick={onDelete} aria-label={`Delete ${task.name}`}>
        Delete
      </button>
    </div>
  );
}

function EditDialog({
  task,
  onClose,
  onSaved,
}: {
  task: TaskViewT;
  onClose: () => void;
  onSaved: (msg: string) => void;
}): JSX.Element {
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt);
  const [maxUsd, setMaxUsd] = useState(String(task.budget.maxUsd));
  const [maxTurns, setMaxTurns] = useState(String(task.budget.maxTurns));
  const [timeoutSec, setTimeoutSec] = useState(String(task.budget.timeoutSec));
  const [permissionMode, setPermissionMode] = useState(task.permissionMode);
  const [chainAfter, setChainAfter] = useState<string | null>(task.chainAfter ?? null);
  const [chainOn, setChainOn] = useState<string>(task.chainOn ?? 'completed');
  // sibling tasks offered as upstream (excluding self)
  const [allTasks, setAllTasks] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api.tasks().then((rows) => setAllTasks(rows.filter((t) => t.id !== task.id).map((t) => ({ id: t.id, name: t.name })))).catch(() => {});
  }, [task.id]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.patchTask(task.id, {
        name,
        prompt,
        permissionMode,
        chainAfter,
        chainOn: chainAfter ? chainOn : undefined,
        budget: { maxUsd: Number(maxUsd) || task.budget.maxUsd, maxTurns: Number(maxTurns) || task.budget.maxTurns, timeoutSec: Number(timeoutSec) || task.budget.timeoutSec },
        version: task.version,
      });
      onSaved('Task saved.');
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setErr(msg.includes('409') || msg.includes('conflict') ? 'This task changed elsewhere — reopen and retry.' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Edit task</h3>
        <label className="f">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="f">Prompt</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row3">
          <div>
            <label className="f">Budget USD</label>
            <input type="number" min="0.1" step="0.5" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} />
          </div>
          <div>
            <label className="f">Max turns</label>
            <input type="number" min="1" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
          </div>
          <div>
            <label className="f">Timeout s</label>
            <input type="number" min="30" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
          </div>
        </div>
        <label className="f">Permission mode</label>
        <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
          <option value="plan">plan (dry-run)</option>
          <option value="acceptEdits">acceptEdits</option>
        </select>

        <label className="f">Chain after (run when that task finishes)</label>
        <select
          value={chainAfter ?? ''}
          onChange={(e) => setChainAfter(e.target.value || null)}
          aria-label="Chain after"
        >
          <option value="">— none —</option>
          {allTasks
            .filter((t) => t.id !== task.id)
            .map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
        </select>
        {chainAfter && (
          <>
            <label className="f">Fire when upstream is…</label>
            <select value={chainOn} onChange={(e) => setChainOn(e.target.value)} aria-label="Chain trigger">
              <option value="completed">completed (recommended)</option>
              <option value="any_terminal">any terminal state</option>
            </select>
          </>
        )}
        {err && <div className="error-banner">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="hint">{body}</p>
        {err && <div className="error-banner">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm().catch((e) => {
                setErr(String((e as Error).message ?? e));
                setBusy(false);
              });
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
