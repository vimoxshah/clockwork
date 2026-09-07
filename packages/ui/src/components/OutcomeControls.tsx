/**
 * F6 accept-with-note (plan/AGENT-WORKFORCE-SPEC.md §F6).
 *
 * Accept / reject / accept-with-note controls for a single run — the
 * explicit human verdict that becomes the acceptance signal F7
 * (earned-autonomy), F10 (timesheets) and F11 (performance-reviews) all read
 * via `run_outcomes`. The note on "accept with note" is written into that
 * task's shift-handoff memory (F2) by the daemon route, not by this file.
 *
 * Self-contained: fetches and posts directly against
 * `/workforce/runs/:runId/outcome` (bearer-token `fetch`, mirroring
 * ProposedEvents.tsx's `downloadIcs`) rather than through `packages/ui/src/api.ts`'s
 * shared `req()` helper. `api.recordOutcome()` is this feature's
 * `packages/ui/src/api.ts` wiring snippet, applied by the integrator — this
 * component does not depend on it, so it typechecks standalone before that
 * snippet lands.
 */
import { useEffect, useState } from 'react';
import { getToken } from '../api';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * Mounted inside InboxView's report detail — reachable once a run is selected
 * and inactive (`{!active && <OutcomeControls .../>}`). No always-rendered
 * host exists for a per-run control, so the anchor is best-effort: honest
 * about "no screen" vs. "a screen that only appears once you have picked a
 * run", never the same as claiming a control with no code behind it.
 */
export const ACCEPT_WITH_NOTE_SURFACE = registerFeatureSurface({
  key: 'accept_with_note',
  tab: 'inbox',
  where: 'Inbox › a run’s report',
  anchorId: 'accept-with-note',
});

export type OutcomeDecisionT = 'accepted' | 'accepted_with_note' | 'rejected';

interface OutcomeRecordT {
  decision: OutcomeDecisionT;
  note: string | null;
}

async function fetchOutcome(runId: string): Promise<OutcomeRecordT | null> {
  try {
    const res = await fetch(`/workforce/runs/${runId}/outcome`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (res.status === 404) return null; // no decision recorded yet — not an error
    if (!res.ok) return null; // best-effort: a failed fetch just hides the "already decided" banner
    return (await res.json()) as OutcomeRecordT;
  } catch {
    return null;
  }
}

async function postOutcome(
  runId: string,
  body: { decision: OutcomeDecisionT; note?: string },
): Promise<{ ok: true; record: OutcomeRecordT } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/workforce/runs/${runId}/outcome`, {
      method: 'POST',
      headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = parsed as { error?: unknown } | null;
      return {
        ok: false,
        error: typeof detail?.error === 'string' ? detail.error : `request failed (${res.status})`,
      };
    }
    return { ok: true, record: parsed as OutcomeRecordT };
  } catch {
    return { ok: false, error: 'daemon unreachable — is clockworkd running?' };
  }
}

export function OutcomeControls({ runId }: { runId: string }): JSX.Element | null {
  const [outcome, setOutcome] = useState<OutcomeRecordT | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setOutcome(null);
    setErr(null);
    void fetchOutcome(runId).then((rec) => {
      if (!alive) return;
      setOutcome(rec);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [runId]);

  const decide = async (decision: OutcomeDecisionT, withNote?: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    const result = await postOutcome(runId, withNote ? { decision, note: withNote } : { decision });
    setBusy(false);
    if (!result.ok) {
      setErr(result.error);
      return;
    }
    setOutcome(result.record);
    setNoteOpen(false);
    setNote('');
  };

  if (!loaded) return null; // avoid a layout flash while the initial fetch resolves

  return (
    <div className="outcome-controls mt-4 border-t border-border pt-3" id={ACCEPT_WITH_NOTE_SURFACE.anchorId}>
      {outcome && (
        <div className="hint mono" data-testid="outcome-current">
          Decision: {outcome.decision.replace(/_/g, ' ')}
          {outcome.note ? ` — "${outcome.note}"` : ''}
        </div>
      )}
      {err && (
        <div className="error-banner" role="alert">
          {err}
        </div>
      )}
      <div className="outcome-actions mt-2 flex flex-wrap items-center gap-2">
        <button
          className="btn primary small"
          data-testid="outcome-accept"
          aria-label="Accept this run's output"
          disabled={busy}
          onClick={() => void decide('accepted')}
        >
          Accept
        </button>
        <button
          className="btn danger small"
          data-testid="outcome-reject"
          aria-label="Reject this run's output"
          disabled={busy}
          onClick={() => void decide('rejected')}
        >
          Reject
        </button>
        <button
          className="btn small"
          data-testid="outcome-note-toggle"
          aria-label="Accept with a note for the next run"
          disabled={busy}
          onClick={() => setNoteOpen((o) => !o)}
        >
          Accept with note…
        </button>
      </div>
      {noteOpen && (
        <div className="outcome-note-form mt-2 flex max-w-md flex-col gap-2">
          <textarea
            className="outcome-note-input"
            data-testid="outcome-note-input"
            aria-label="Note for the next run"
            placeholder="What should the next run know?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="btn primary small"
            data-testid="outcome-note-submit"
            aria-label="Submit accept with note"
            disabled={busy || note.trim().length === 0}
            onClick={() => void decide('accepted_with_note', note)}
          >
            Submit note
          </button>
        </div>
      )}
    </div>
  );
}
