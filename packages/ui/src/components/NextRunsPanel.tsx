/**
 * The next few fires for the rule currently in the composer (SCH-5).
 *
 * The composer used to offer only shapes it could not get wrong — daily, one
 * weekday, one day of the month. Intervals, multi-day weeks and hour windows
 * are shapes a person CAN get wrong, and a recurrence that looks right and
 * never fires is invisible until the day it does not run. So the rule is sent
 * to the daemon, which answers with real instants or with the reason it
 * refuses, and both are shown before the task is booked.
 *
 * It debounces because it is driven by typing, and it drops out-of-order
 * answers because a slow reply for an older rule would otherwise overwrite the
 * newer one and describe a schedule the user has already moved past.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type SchedulePreviewT } from '../api';
import { CalendarClock, AlertCircle } from 'lucide-react';

const DEBOUNCE_MS = 250;

export interface NextRunsPanelProps {
  /** The rule to preview, or the local validation error that stopped it being built. */
  rrule: string | null;
  localError: string | null;
  tz: string;
}

export function NextRunsPanel({ rrule, localError, tz }: NextRunsPanelProps): JSX.Element {
  const [state, setState] = useState<{ runs: number[] } | { error: string } | 'loading' | null>(null);
  /** Monotonic request id: only the newest answer is allowed to land. */
  const latest = useRef(0);

  useEffect(() => {
    if (localError != null || rrule == null) {
      setState(null);
      return;
    }
    const seq = ++latest.current;
    setState('loading');
    const timer = setTimeout(() => {
      void api
        .previewSchedule({ kind: 'rrule', rrule, tz })
        .then((res: SchedulePreviewT) => {
          if (seq !== latest.current) return;
          if (res.runs) setState({ runs: res.runs });
          else setState({ error: res.error });
        })
        .catch((e: unknown) => {
          if (seq !== latest.current) return;
          setState({ error: `Could not reach the daemon: ${String(e)}` });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rrule, localError, tz]);

  if (localError != null) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3 text-xs text-muted" data-testid="next-runs">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="leading-relaxed">{localError}</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3" data-testid="next-runs">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        <CalendarClock className="h-3.5 w-3.5" />
        <span>Next 5 runs</span>
      </div>
      {state === null && <p className="text-xs text-dim">Pick a repeat to see when it fires.</p>}
      {state === 'loading' && <p className="text-xs text-dim">Checking…</p>}
      {state !== null && state !== 'loading' && 'error' in state && (
        <p className="flex items-start gap-2 text-xs text-danger" role="alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="leading-relaxed">{state.error}</span>
        </p>
      )}
      {state !== null && state !== 'loading' && 'runs' in state && (
        state.runs.length === 0 ? (
          <p className="text-xs text-danger" role="alert">This rule never fires.</p>
        ) : (
          <ol className="space-y-1">
            {state.runs.map((at) => (
              <li key={at} className="mono text-xs text-fg">
                {new Date(at).toLocaleString(undefined, {
                  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </li>
            ))}
          </ol>
        )
      )}
    </div>
  );
}
