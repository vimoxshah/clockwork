/**
 * F2 shift-handoff memory (plan/AGENT-WORKFORCE-SPEC.md §F2,
 * docs/agent-workforce.md "F2 — Shift-handoff memory").
 *
 * A recurring task carries memory across occurrences — what the last run
 * tried, what blocked it, what to check next — so the next run of the SAME
 * task does not start cold. Mounted where a task's runs are read (the Inbox
 * report pane; App.tsx's own routing note: "Inbox — proof-of-work, shift
 * handoff — they hang off one run"), keyed off `run.task_id` rather than
 * `run.id` — the memory belongs to the task, not to any one occurrence.
 *
 * `version` is threaded down from ReportDetail so the daemon's
 * `workforce.memory_appended` broadcast (and F6 accept-with-note, which
 * writes here too) refreshes this list without a manual reload.
 *
 * The daemon injects this memory into the NEXT run's prompt only when that
 * prompt contains the literal `{{handoff.previous}}` placeholder
 * (handoff.ts renderHandoffPrompt). A run's own stored `jobspec_json.prompt`
 * cannot be used to detect that: by the time it is stored the placeholder
 * has already been substituted away, present or not (`replace(...)` runs
 * unconditionally with an empty block when there is no memory yet), so the
 * reminder below is a standing fact about the feature rather than a
 * per-task check this view has no honest way to make.
 */
import { useState } from 'react';
import { api, type AgentMemoryT } from '../api';
import { useAsync } from '../useAsync';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * Mounted inside InboxView's report detail for every run (unconditional
 * inside ReportDetail, once a run is selected — see InboxView.tsx
 * `<TaskMemoryPanel .../>`). Anchor is best-effort: no run is selected by
 * default when Inbox first mounts.
 */
export const SHIFT_HANDOFF_SURFACE = registerFeatureSurface({
  key: 'shift_handoff',
  tab: 'inbox',
  where: 'Inbox › a run’s report',
  anchorId: 'shift-handoff',
});

const LIMIT = 10;

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function MemoryEntry({ m }: { m: AgentMemoryT }): JSX.Element {
  const hasStructured = Boolean(m.tried || m.blocked || m.nextCheck);
  return (
    <div className="memory-entry" data-testid="memory-entry">
      <div className="hint mono" style={{ margin: 0 }}>
        {m.author === 'human' ? 'You' : 'Agent'} · {m.kind === 'note' ? 'note' : 'handoff'} · {fmtWhen(m.createdAt)}
      </div>
      {m.tried && <div>Tried: {m.tried}</div>}
      {m.blocked && <div>Blocked: {m.blocked}</div>}
      {m.nextCheck && <div>Next check: {m.nextCheck}</div>}
      {!hasStructured && m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}
    </div>
  );
}

export function TaskMemoryPanel({
  taskId,
  runId,
  version,
}: {
  taskId: string;
  runId: string;
  version: number;
}): JSX.Element {
  const memory = useAsync(() => api.handoff(taskId, LIMIT), [taskId, version]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // POST 422s "unknown task" for a soft-deleted task (daemon api.ts:2357);
  // GET still works, so history stays visible and only the write path closes.
  const [taskGone, setTaskGone] = useState(false);

  const addNote = async (): Promise<void> => {
    const body = note.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      await api.handoffAppend(taskId, { author: 'human', kind: 'note', body, runId });
      setNote('');
      memory.reload();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('unknown task')) setTaskGone(true);
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const memories = memory.data?.memories ?? [];

  return (
    <div className="task-memory mt-4 border-t border-border pt-3">
      <h3 className="section-title" id={SHIFT_HANDOFF_SURFACE.anchorId}>Shift handoff — this task’s memory</h3>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Carries across every occurrence of this task: what it tried, what blocked it, what to check next.
        Reaches the agent only if this task’s prompt includes the <code className="mono">{'{{handoff.previous}}'}</code>{' '}
        placeholder.
      </p>
      {memory.loading && (
        <div className="state-line">
          <span className="spinner" /> Loading memory…
        </div>
      )}
      {memory.error && (
        <div className="error-banner" role="alert">
          Couldn’t load this task’s memory: {memory.error}
          <div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={memory.reload}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!memory.loading && !memory.error && memories.length === 0 && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Nothing carried over yet — add the first note below so the next run of this task doesn’t start cold.
        </p>
      )}
      {!memory.loading && !memory.error && memories.length > 0 && (
        <div className="flex flex-col gap-2" style={{ marginBottom: 8 }}>
          {memories.map((m) => (
            <MemoryEntry key={m.id} m={m} />
          ))}
        </div>
      )}

      {taskGone ? (
        <p className="hint">This task was deleted — its memory is kept for history but is read-only now.</p>
      ) : (
        <div className="flex max-w-md flex-col gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What should the next run know?"
            aria-label="Add a memory note for this task"
            data-testid="memory-note-input"
          />
          {err && (
            <div className="error-banner" role="alert">
              {err}
            </div>
          )}
          <div>
            <button
              className="btn small"
              data-testid="memory-note-submit"
              disabled={busy || note.trim().length === 0}
              onClick={() => void addNote()}
            >
              Add note
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
