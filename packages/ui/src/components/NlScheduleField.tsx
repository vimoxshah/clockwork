/**
 * Natural-language schedule field (P1): "every Mon 2am" typed above the
 * builder, interpreted live with a daemon-backed preview of the candidate,
 * applied into the SAME builder state Book-it reads only when the user
 * presses Apply.
 *
 * Explicit Apply (not live-apply) is the design, twice over. First, typing
 * must never rewrite the tabs below — a debounce plus an effect key still
 * clobbers hand edits with no confirm and no undo. Second, P2.5 demands one
 * schedule model: the builder is it, and this field is a lens onto it, not a
 * second representation. The candidate preview (interpretation + next runs
 * from the daemon's previewSchedule, the same route the panel uses) gives
 * the instantaneous feel without touching builder state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseNaturalSchedule, type NlResult } from '../lib/natural-schedule';
import type { Weekday, IntervalMinutes } from '../lib/schedule-rule';
import { NextRunsPanel } from './NextRunsPanel';

export interface NlApplyRrule {
  kind: 'rrule';
  rruleFreq: 'INTERVAL' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  rruleByDay: Weekday[];
  rruleTime: string;
  monthlyDay: string;
  intervalEvery: IntervalMinutes;
  intervalDays: Weekday[];
  intervalFromHour: string;
  intervalToHour: string;
}

export interface NlApplyOnce {
  kind: 'once';
  runAt: Date;
}

export type NlApply = NlApplyRrule | NlApplyOnce;

function toTimeString(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/**
 * The Apply decision, exported for tests: given the LIVE text (not a
 * rendered candidate), parse and apply or do nothing. Returning false means
 * "nothing booked" — the caller keeps the field open on the error path the
 * debounced parse already shows.
 */
export function applyLiveText(text: string, tz: string, onApply: (applied: NlApply) => void): boolean {
  const live = parseNaturalSchedule({ text, nowMs: Date.now(), tz });
  const applied = draftToForm(live);
  if (!applied) return false;
  onApply(applied);
  return true;
}

/** Draft from the parser → builder fields. Total: every draft field lands. */
export function draftToForm(d: NlResult): NlApply | null {
  if (d.kind === 'once') return { kind: 'once', runAt: new Date(d.runAt) };
  if (d.kind === 'error') return null;
  const time = toTimeString(d.draft.hour, d.draft.minute);
  switch (d.draft.freq) {
    case 'DAILY':
      // A scoped daily ("weekdays") is a WEEKLY rule wearing a daily label —
      // the builder's DAILY tab cannot hold days, so map it to WEEKLY or the
      // preview would confirm a rule Book-it never sends.
      if (d.draft.days.length > 0) {
        return {
          kind: 'rrule', rruleFreq: 'WEEKLY', rruleByDay: d.draft.days, rruleTime: time, monthlyDay: '1',
          intervalEvery: 15, intervalDays: [], intervalFromHour: '0', intervalToHour: '24',
        };
      }
      return {
        kind: 'rrule', rruleFreq: 'DAILY', rruleByDay: [], rruleTime: time, monthlyDay: '1',
        intervalEvery: 15, intervalDays: [], intervalFromHour: '0', intervalToHour: '24',
      };
    case 'WEEKLY':
      return {
        kind: 'rrule', rruleFreq: 'WEEKLY', rruleByDay: d.draft.days, rruleTime: time, monthlyDay: '1',
        intervalEvery: 15, intervalDays: [], intervalFromHour: '0', intervalToHour: '24',
      };
    case 'MONTHLY':
      return {
        kind: 'rrule', rruleFreq: 'MONTHLY', rruleByDay: [], rruleTime: time, monthlyDay: String(d.draft.dom ?? 1),
        intervalEvery: 15, intervalDays: [], intervalFromHour: '0', intervalToHour: '24',
      };
    case 'INTERVAL':
      return {
        kind: 'rrule', rruleFreq: 'INTERVAL', rruleByDay: [], rruleTime: time, monthlyDay: '1',
        intervalEvery: d.draft.every ?? 15, intervalDays: d.draft.days,
        intervalFromHour: String(d.draft.fromHour ?? 0), intervalToHour: String(d.draft.toHour ?? 24),
      };
  }
}

export default function NlScheduleField({
  tz,
  onApply,
}: {
  tz: string;
  onApply: (applied: NlApply) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  // Live-text mirror, written synchronously in onChange: the click handler
  // below must decide on what is TYPED, not what last rendered. A click in
  // the same tick as a keystroke otherwise applies the previous candidate —
  // the disabled flag has not re-rendered yet, so it cannot stop it.
  const textRef = useRef('');

  useEffect(() => {
    if (!text.trim()) {
      setDebounced('');
      return;
    }
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  // tz is a key, not just a dependency: the same text in another zone is a
  // different schedule, and a stale candidate must never linger.
  const parsed: NlResult | null = useMemo(
    () => (debounced.trim() ? parseNaturalSchedule({ text: debounced, nowMs: Date.now(), tz }) : null),
    [debounced, tz],
  );
  const candidateRrule = parsed && parsed.kind === 'rrule' ? parsed.rrule : null;
  // The candidate lags the keystrokes by the debounce. Applying while it lags
  // would book the PREVIOUS text's schedule under the current text — so Apply
  // stays disabled until the parse catches up, and the stale result dims.
  const pending = text.trim() !== '' && debounced !== text;

  return (
    <div className="mb-3" data-testid="nl-schedule">
      <label className="f" htmlFor="nl-schedule-input">
        Describe the schedule
      </label>
      <input
        id="nl-schedule-input"
        data-testid="nl-schedule-input"
        className="cred-field"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          textRef.current = e.target.value;
          setText(e.target.value);
        }}
        placeholder='Try "every Mon 2am" or "weekdays at 9"'
        aria-describedby="nl-schedule-result"
      />
      <div id="nl-schedule-result" aria-live="polite">
        {parsed && parsed.kind !== 'error' && (
          <div className="mt-2 text-xs" data-testid="nl-schedule-ok" style={pending ? { opacity: 0.55 } : undefined}>
            <span>
              {parsed.confidence === 'high' ? '✓' : '⚠'} {parsed.interpretation}
            </span>
            {parsed.warnings.map((w) => (
              <p key={w} className="text-dim" data-testid="nl-schedule-warning">
                ⚠ Assumes: {w}
              </p>
            ))}
            {candidateRrule && (
              <div className="mt-2">
                <NextRunsPanel rrule={candidateRrule} localError={null} tz={tz} />
              </div>
            )}
            <button
              className="btn small primary mt-2"
              data-testid="nl-schedule-apply"
              disabled={pending}
              title={pending ? 'Waiting for the latest text to parse…' : undefined}
              onClick={() => {
                // Live text, not the rendered candidate — see textRef above.
                if (applyLiveText(textRef.current, tz, onApply)) {
                  textRef.current = '';
                  setText('');
                  setDebounced('');
                }
              }}
            >
              Apply this schedule
            </button>
          </div>
        )}
        {parsed && parsed.kind === 'error' && debounced.trim() && (
          <div className="error-banner mt-2 text-xs" role="alert" data-testid="nl-schedule-error">
            {parsed.message} {parsed.hint}
          </div>
        )}
      </div>
    </div>
  );
}
