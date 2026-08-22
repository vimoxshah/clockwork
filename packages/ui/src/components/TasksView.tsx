/**
 * Tasks (FR-5/FR-6): list with queue lane, run-now w/ feedback, edit dialog
 * (name/prompt/budget/mode), delete with confirmation, enable/pause reflecting
 * server state.
 */
import { useState } from 'react';
import { api, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';

export default function TasksView({ version }: { version: number }): JSX.Element {
  const tasks = useAsync(() => api.tasks(), [version]);
  const queue = useAsync(() => api.queue(), [version]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskViewT | null>(null);
  const [deleting, setDeleting] = useState<TaskViewT | null>(null);

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
    <div style={{ maxWidth: 820 }}>
      {queue.data && queue.data.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 className="section-title">Queue</h3>
          {queue.error && <div className="error-banner">Couldn’t load queue: {queue.error}</div>}
          {queue.data.map((q) => (
            <div key={q.runId} className="tasklist-row" data-testid={`queue-${q.position}`}>
              <span className="chip running">#{q.position}</span>
              <div className="grow">
                <strong>{q.name}</strong>
                <div className="hint" style={{ margin: 0 }}>{q.reason}</div>
              </div>
              <button className="btn danger small" onClick={() => void act(() => api.cancelRun(q.runId))}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 className="section-title">Tasks</h3>
        <button className="btn small" onClick={() => { tasks.reload(); queue.reload(); }} aria-label="Refresh tasks">
          ⟳ Refresh
        </button>
      </div>

      {notice && <div className="ok-banner">{notice}</div>}
      {actionErr && <div className="error-banner" role="alert">{actionErr}</div>}

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

      {(tasks.data ?? []).map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          onRunNow={() => void act(() => api.runNow(t.id), `Run queued for “${t.name}” — watch the calendar or inbox.`)}
          onToggle={() => void act(() => api.patchTask(t.id, { enabled: !t.enabled, version: t.version }))}
          onEdit={() => setEditing(t)}
          onDelete={() => setDeleting(t)}
        />
      ))}

      {editing && (
        <EditDialog
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            void act(async () => {}, msg);
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
