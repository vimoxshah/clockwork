/**
 * Every recurrence string the composer can emit, in one place.
 *
 * It lives here rather than in `@clockwork/shared` because the UI is a pure
 * wire client and imports nothing from that package (see api.ts). The daemon
 * therefore cannot import this emitter, and the two sides are kept honest by a
 * checked-in fixture instead: `packages/shared/fixtures/emittable-schedules.json`
 * lists every string this file can produce, a test here asserts the emitter
 * still produces exactly that set, and a test in the daemon asserts every entry
 * in it is safe to expand. Neither package reaches across the boundary.
 *
 * WHY "EVERY N MINUTES" IS `FREQ=HOURLY` AND NOT `FREQ=MINUTELY`.
 *
 * The obvious spelling of "every 15 minutes on weekdays, 9 to 5" is
 * `FREQ=MINUTELY;INTERVAL=15;BYDAY=MO..FR;BYHOUR=9..16`. It hangs. Not slowly —
 * forever, inside rrule 2.8.1, and it takes the daemon's request thread with it.
 *
 * Measured out of process with an 8-second watchdog on 2026-09-08, expanding an
 * 8-day window in America/New_York:
 *
 *   FREQ=MINUTELY;INTERVAL={5,15,30};BYDAY=MO;BYHOUR=9..16      -> HANG (all three)
 *   FREQ=MINUTELY;INTERVAL={5,15,30};BYDAY=SA;BYHOUR=9..16      -> HANG (all three)
 *   FREQ=MINUTELY;INTERVAL=15;BYDAY=MO..FR;BYHOUR=9..11
 *     anchored on a Tuesday                                     -> 15ms
 *     anchored on a SATURDAY                                    -> HANG
 *   FREQ=HOURLY;BYDAY=<any of the above>;BYHOUR=9..16;BYMINUTE=<grid> -> 12-23ms
 *
 * The pattern is the one `recurrence.ts` describes from the other side: below
 * HOURLY, `DateTime.addMinutes` normalizes its carry through
 * `addHours(hourDiv, false, byhour)`, whose skip loop re-adds hours for every
 * hour BYHOUR rejects, while a whole-day filter makes the counter jump a whole
 * day at a time. When the anchor's own day is rejected by BYDAY the two never
 * resynchronise. HOURLY has no such loop: `addHours` adds exactly INTERVAL
 * hours per step and rechecks BYHOUR at each one, "so it can neither leave the
 * grid nor skip a matching point."
 *
 * So an interval is expressed as the minutes of the hour it lands on — every 15
 * minutes IS `BYMINUTE=0,15,30,45` — which is both safe and a more literal
 * reading of what the user asked for. It also needs no DTSTART: HOURLY is a
 * frequency `advancedAnchorMs` advances unconditionally, so the synthesized
 * anchor is already moved next to the window and the widest rule this file can
 * emit costs 14ms with no anchor stated at all.
 */

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** The intervals offered. Each divides 60, so each is a whole set of BYMINUTE values. */
export const INTERVAL_MINUTES = [5, 10, 15, 30] as const;
export type IntervalMinutes = (typeof INTERVAL_MINUTES)[number];

/** `0,15,30,45` for 15 — the minutes of the hour an interval actually lands on. */
export function minuteGrid(every: IntervalMinutes): string {
  return Array.from({ length: 60 / every }, (_, i) => i * every).join(',');
}

/** `[9..16]` for 9–17 — the END hour is exclusive, as a "nine to five" day is. */
export function hourRange(fromHour: number, toHour: number): number[] {
  const last = Math.max(fromHour, toHour - 1);
  return Array.from({ length: last - fromHour + 1 }, (_, i) => fromHour + i);
}

function orderDays(days: readonly Weekday[]): Weekday[] {
  return [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

export interface IntervalDraft {
  every: IntervalMinutes;
  days: readonly Weekday[];
  fromHour: number;
  /** Exclusive, so 9–17 is a nine-to-five day and 0–24 is all day. */
  toHour: number;
}

/**
 * "Every N minutes", optionally narrowed to some days and an hour window.
 * BYDAY and BYHOUR are omitted when they would select everything — an
 * unnarrowing filter is still a filter to rrule, and the fewer the better.
 */
export function composeIntervalRule(draft: IntervalDraft): string {
  const parts = ['FREQ=HOURLY'];
  if (draft.days.length > 0 && draft.days.length < WEEKDAYS.length) {
    parts.push(`BYDAY=${orderDays(draft.days).join(',')}`);
  }
  const hours = hourRange(draft.fromHour, draft.toHour);
  if (hours.length > 0 && hours.length < 24) parts.push(`BYHOUR=${hours.join(',')}`);
  parts.push(`BYMINUTE=${minuteGrid(draft.every)}`);
  return parts.join(';');
}

/** `FREQ=WEEKLY` over one or more days. Multi-day is the change; it was single-select. */
export function composeWeeklyRule(days: readonly Weekday[], hour: number, minute: number): string {
  return `FREQ=WEEKLY;BYDAY=${orderDays(days).join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
}

export function composeDailyRule(hour: number, minute: number): string {
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
}

export function composeMonthlyRule(dayOfMonth: number, hour: number, minute: number): string {
  return `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth};BYHOUR=${hour};BYMINUTE=${minute}`;
}
