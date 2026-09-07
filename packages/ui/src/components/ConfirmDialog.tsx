/**
 * A destructive action, confirmed. Lifted out of TasksView unchanged so the
 * workforce sections (sentinel delete, pair rejection) can reuse it without
 * importing back into the view that renders them — a cycle React would not
 * thank us for. TasksView still re-exports it, so the old import path works.
 */
import { useState } from 'react';

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
