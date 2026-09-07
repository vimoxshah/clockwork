/**
 * F9 proposed-events (plan/AGENT-WORKFORCE-SPEC.md §F9).
 *
 * Renders a run's agent-suggested calendar events and offers them as a
 * downloadable .ics. **Clockwork never writes to the user's real
 * calendar** — the only output is a file the user downloads and imports
 * themselves through their own calendar app.
 *
 * `events` is supplied by the caller as `report?.proposedEvents ?? []` (the
 * field is optional on the report — undefined for a report predating it, or
 * a run that proposed nothing), so this component never fetches on its own
 * for the inline list. The download itself hits the daemon's `.ics` route
 * directly (bearer-token fetch → blob → object URL) because the shared
 * `api.ts` request helper parses every response as JSON and cannot carry a
 * `text/calendar` body.
 */
import { getToken } from '../api';
import { registerFeatureSurface } from './featureSurfaces';

/**
 * Mounted inside InboxView's report detail, but only renders once a run's
 * report actually carries proposed events (`if (!events.length) return
 * null;`) — so the anchor exists only on a run that proposed something. That
 * is a real, data-dependent gap in this screen (flagged, not fixed here: out
 * of scope for feature-surface registration), not an absent screen — the
 * component and its daemon route both exist and are mounted.
 */
export const PROPOSED_EVENTS_SURFACE = registerFeatureSurface({
  key: 'proposed_events',
  tab: 'inbox',
  where: 'Inbox › a run’s report (when it proposes events)',
  anchorId: 'proposed-events',
});

export interface ProposedEventT {
  key: string;
  title: string;
  notes: string | null;
  durationMin: number;
  suggestedAt: number | null;
}

async function downloadIcs(runId: string): Promise<void> {
  try {
    const res = await fetch(`/workforce/runs/${runId}/proposed-events.ics`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return; // best-effort: a failed download leaves the list visible, no crash
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clockwork-${runId}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // network failure — nothing to recover, the user can retry the click
  }
}

/** Seconds are meaningless for a calendar suggestion — drop them, keep date + minute precision. */
function formatSuggestedAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ProposedEvents({ runId, events }: { runId: string; events: ProposedEventT[] }): JSX.Element | null {
  if (!events.length) return null;

  return (
    <div className="proposed-events">
      <h3 id={PROPOSED_EVENTS_SURFACE.anchorId}>Suggested calendar events</h3>
      <ul>
        {events.map((ev) => (
          <li key={ev.key}>
            <strong>{ev.title}</strong>
            <span className="hint"> · {ev.durationMin}m</span>
            {ev.suggestedAt != null && (
              <span className="hint"> · {formatSuggestedAt(ev.suggestedAt)}</span>
            )}
            {ev.notes && <div className="hint">{ev.notes}</div>}
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={() => void downloadIcs(runId)}>
        Download .ics
      </button>
    </div>
  );
}
