/**
 * TimeField — the one control every "what time?" question in the app uses.
 *
 * There were three before this: a native `<input type="time">` in the composer's
 * recurring tab, two more in Office hours, and a pair of bare number inputs for
 * the interval window. A native time input is drawn by the OS — in WKWebView,
 * which is what the desktop window is, that means an OS widget that ignores the
 * theme and dark mode, and on the recurring tab it was the reported "not able to
 * select the time".
 *
 * The value is MINUTES FROM MIDNIGHT, not a string. Every call site already had
 * to convert to something — "HH:MM" here, an hour number there — and picking one
 * integer contract means the conversions live at the edges instead of inside the
 * control. It also gives 24:00 somewhere to live: Office hours ends at 1440,
 * which "HH:MM" cannot spell (`minToTime(1440)` is "00:00", the same string as
 * the start of the day). See `allowEndOfDay`.
 */
import { useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export const MINUTES_PER_DAY = 1440;

/** 1440 — the END of the day, which is not the same instant as 0. */
export const END_OF_DAY = MINUTES_PER_DAY;

const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Label an hour through the same locale machinery the rest of the app formats
 * with, so a 12-hour locale reads "2 PM" here and "02:00 PM" on a trigger,
 * rather than "2 PM" here and "14" there.
 *
 * Exported because prose ABOUT the hours has to match the control: a hint that
 * hard-codes "9 AM to 5 PM" sits under a 24-hour locale's "09" and "17".
 */
export function hourLabel(h: number): string {
  const d = new Date(2000, 0, 1, h, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
}

/**
 * The minutes offered, which is the step grid PLUS whatever is already stored.
 *
 * A pure grid cannot render a value off it: a saved 09:37 would come back as
 * 09:35 the moment someone opened the form to look at it, and nothing would say
 * so. A full 0–59 list avoids that and is 60 rows to scroll. Including the
 * current value keeps the list short for the common case and exact for the
 * stored one.
 */
export function minuteOptions(step: number, current: number): number[] {
  const grid = new Set<number>();
  for (let m = 0; m < 60; m += step) grid.add(m);
  grid.add(current);
  return [...grid].sort((a, b) => a - b);
}

export function TimeField({
  value,
  onChange,
  id,
  minuteStep = 5,
  allowEndOfDay = false,
  hourOnly = false,
  ariaLabelPrefix = 'Time',
  testIdPrefix,
  disabled,
}: {
  /** Minutes from midnight. `allowEndOfDay` extends the range to 1440. */
  value: number;
  onChange: (minutes: number) => void;
  id?: string;
  minuteStep?: number;
  /** Offer 24:00 (1440) as the end of THIS day rather than the start of the next. */
  allowEndOfDay?: boolean;
  /** Hide the minute control — for a window whose grain is whole hours. */
  hourOnly?: boolean;
  ariaLabelPrefix?: string;
  testIdPrefix?: string;
  disabled?: boolean;
}): JSX.Element {
  const isEnd = allowEndOfDay && value >= MINUTES_PER_DAY;
  const hour = isEnd ? 24 : Math.floor(value / 60);
  const minute = isEnd ? 0 : value % 60;

  const hours = useMemo(() => {
    const list = Array.from({ length: 24 }, (_, h) => ({ h, label: hourLabel(h) }));
    // 24:00 rather than "12 AM": in a 12-hour locale the end of the day and the
    // start of it are the same three characters, and the whole reason this
    // option exists is that they are different instants.
    return allowEndOfDay ? [...list, { h: 24, label: '24:00' }] : list;
  }, [allowEndOfDay]);

  const minutes = useMemo(() => minuteOptions(minuteStep, minute), [minuteStep, minute]);

  const setHour = (h: number): void => {
    if (h === 24) return onChange(END_OF_DAY);
    onChange(h * 60 + minute);
  };
  const setMinute = (m: number): void => {
    // Choosing a minute while the field reads 24:00 has to mean an hour, and
    // hour 0 is the only sensible reading of "the end of the day, but :15".
    onChange((isEnd ? 0 : hour) * 60 + m);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))} disabled={disabled}>
        <SelectTrigger
          id={id}
          aria-label={[ariaLabelPrefix, 'hour'].filter(Boolean).join(' ')}
          className="h-9 w-[6rem]"
          data-testid={testIdPrefix ? `${testIdPrefix}-hour` : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {hours.map((o) => (
            <SelectItem key={o.h} value={String(o.h)}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!hourOnly && (
        <>
          <span className="text-dim">:</span>
          <Select
            value={String(minute)}
            onValueChange={(v) => setMinute(Number(v))}
            disabled={disabled || isEnd}
          >
            <SelectTrigger
              aria-label={[ariaLabelPrefix, 'minute'].filter(Boolean).join(' ')}
              className="h-9 w-[4.5rem]"
              data-testid={testIdPrefix ? `${testIdPrefix}-minute` : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {minutes.map((m) => (
                <SelectItem key={m} value={String(m)}>{p2(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}

/** "09:30" → 570. Returns null on anything that is not a wall clock. */
export function timeStringToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 570 → "09:30". 1440 wraps to "00:00" — callers that mean 24:00 must say so. */
export function minutesToTimeString(min: number): string {
  return `${p2(Math.floor(min / 60) % 24)}:${p2(min % 60)}`;
}
