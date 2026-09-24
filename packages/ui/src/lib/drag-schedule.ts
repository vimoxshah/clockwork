/**
 * Drag/drop schedule moves (P2): a calendar day + the task's current schedule
 * in, a PATCH-ready schedule out — or a refusal with the reason.
 *
 * Same model as everything else: moves are expressed ONLY as the schedule
 * shapes the composer emits (schedule-rule.ts compose*), validated by the
 * same guard at save. The daemon re-validates regardless; this module's job
 * is to never ask it to refuse, and to say why when a move is meaningless:
 *
 *   - once      → new date, original wall time preserved
 *   - weekly, one day → new weekday, same time (moves the whole series)
 *   - monthly   → new month-day (1–28), same time
 *   - queue     → becomes a once on the drop day, 9:00 AM, said out loud
 *   - daily / interval / cron / multi-day weekly → REFUSE (the move means
 *     nothing, or means several things — edit in Tasks instead)
 *
 * Past drops refuse client-side too (the daemon would 422 under S-23), so
 * the ghost never promises what the save cannot keep.
 */
import {
  composeWeeklyRule,
  composeMonthlyRule,
  type Weekday,
} from './schedule-rule';
import { wallInTz, wallToUtcMs } from './natural-schedule';

export interface MoveSource {
  kind: 'once' | 'rrule' | 'cron' | 'queue';
  rrule: string | null;
  runAt: number | null;
  tz: string;
  version: number;
}

export interface MoveOk {
  ok: true;
  /** PATCH /tasks/:id body fragment (caller adds nothing else). */
  patch: { schedule: { kind: 'once'; runAt: number; tz: string } | { kind: 'rrule'; rrule: string; tz: string }; version: number };
  interpretation: string;
  warnings: string[];
}

export interface MoveRefusal {
  ok: false;
  reason: 'meaningless' | 'ambiguous' | 'past' | 'unsupported' | 'invalid';
  message: string;
}

export type MoveResult = MoveOk | MoveRefusal;

const JS_TO_CODE: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function codeForJsDay(js: number): Weekday {
  return JS_TO_CODE[js]!;
}

function dayName(code: Weekday): string {
  return { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }[code];
}

function fmtTime(hour: number, minute: number): string {
  const ap = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${ap}`;
}

interface ParsedRule {
  freq: 'WEEKLY' | 'DAILY' | 'MONTHLY' | 'HOURLY';
  days: Weekday[];
  hour: number;
  minute: number;
  dom: number | null;
}

/**
 * Parse ONLY composer-emitted shapes. Anything else (cron text, INTERVAL,
 * COUNT, hand-written rules) returns null and the move refuses — the mover
 * must never rewrite a rule it cannot read exactly.
 */
export function parseEmittedRrule(rrule: string): ParsedRule | null {
  const parts = Object.fromEntries(
    rrule.split(';').map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const freq = parts['FREQ'];
  if (freq !== 'WEEKLY' && freq !== 'DAILY' && freq !== 'MONTHLY' && freq !== 'HOURLY') return null;
  if (parts['INTERVAL'] !== undefined || parts['COUNT'] !== undefined || parts['UNTIL'] !== undefined) return null;
  const num = (v: string | undefined): number | null => {
    if (v === undefined || !/^\d+$/.test(v)) return null;
    return Number(v);
  };
  // HOURLY interval grids carry a BYMINUTE list ("0,15,30,45") and no BYHOUR
  // when all-day — validate the grid, but the mover refuses HOURLY regardless
  // (a move is meaningless there), so hour/minute stay 0.
  const days: Weekday[] = [];
  if (parts['BYDAY'] !== undefined) {
    for (const d of parts['BYDAY'].split(',')) {
      if (!['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(d)) return null;
      days.push(d as Weekday);
    }
    if (days.length === 0) return null;
  }
  if (freq === 'HOURLY') {
    const grid = (parts['BYMINUTE'] ?? '').split(',');
    if (grid.length === 0 || !grid.every((g) => /^\d+$/.test(g) && Number(g) <= 59)) return null;
    return { freq, days, hour: 0, minute: 0, dom: null };
  }
  const hour = num(parts['BYHOUR']);
  const minute = num(parts['BYMINUTE']);
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  let dom: number | null = null;
  if (freq === 'MONTHLY') {
    dom = num(parts['BYMONTHDAY']);
    if (dom === null || dom < 1 || dom > 28) return null;
  } else if (parts['BYMONTHDAY'] !== undefined || parts['BYMONTH'] !== undefined || parts['BYYEARDAY'] !== undefined) {
    return null;
  }
  if (freq === 'WEEKLY' && days.length === 0) return null;
  return { freq, days, hour, minute, dom };
}

function refuse(reason: MoveRefusal['reason'], message: string): MoveRefusal {
  return { ok: false, reason, message };
}

/**
 * Compute the move. drop is a CALENDAR-DAY timestamp (any instant that day);
 * the date is read in the SCHEDULE's timezone, never the machine's.
 */
export function computeMove(src: MoveSource, dropTs: number, nowMs: number): MoveResult {
  const drop = wallInTz(dropTs, src.tz);
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: src.tz, month: 'short', day: 'numeric' }).format(new Date(dropTs));

  if (src.kind === 'queue') {
    const runAt = wallToUtcMs({ y: drop.y, mo: drop.mo, d: drop.d, h: 9, mi: 0 }, src.tz);
    if (runAt <= nowMs) return refuse('past', `${dayLabel} is already past — queue jobs can only land on a future day.`);
    return {
      ok: true,
      patch: { schedule: { kind: 'once', runAt, tz: src.tz }, version: src.version },
      interpretation: `Booked once on ${dayLabel} at 9:00 AM (${src.tz})`,
      warnings: ['Assumed 9:00 AM — a queued job has no time until it lands on a day.'],
    };
  }

  if (src.kind === 'cron') {
    return refuse('unsupported', 'Hand-written cron rules move by editing, not dragging — the mover only reads composer shapes.');
  }

  if (src.kind === 'once') {
    if (src.runAt === null) return refuse('invalid', 'This one-off has no scheduled time to move from.');
    const orig = wallInTz(src.runAt, src.tz);
    const runAt = wallToUtcMs({ y: drop.y, mo: drop.mo, d: drop.d, h: orig.h, mi: orig.mi }, src.tz);
    if (runAt <= nowMs) return refuse('past', `${dayLabel} ${fmtTime(orig.h, orig.mi)} is already past — drop on a future day.`);
    return {
      ok: true,
      patch: { schedule: { kind: 'once', runAt, tz: src.tz }, version: src.version },
      interpretation: `Moved to ${dayLabel} at ${fmtTime(orig.h, orig.mi)} (${src.tz})`,
      warnings: [],
    };
  }

  // rrule from here.
  if (!src.rrule) return refuse('invalid', 'This schedule has no rule to rewrite.');
  const parsed = parseEmittedRrule(src.rrule);
  if (!parsed) {
    return refuse('unsupported', 'This rule was not built by the composer — move it by editing the task, not dragging.');
  }
  if (parsed.freq === 'DAILY') {
    return refuse('meaningless', 'A daily job already fires every day — dragging it to a day changes nothing. Edit its time in Tasks.');
  }
  if (parsed.freq === 'HOURLY') {
    return refuse('meaningless', 'This job runs every few minutes already — dragging it to a day changes nothing. Edit it in Tasks.');
  }
  if (parsed.freq === 'WEEKLY') {
    if (parsed.days.length !== 1) {
      return refuse('ambiguous', `This rule fires on ${parsed.days.length} days — dragging it to one day could mean move or narrow. Edit its days in Tasks.`);
    }
    const js = new Date(Date.UTC(drop.y, drop.mo, drop.d)).getUTCDay();
    const code = codeForJsDay(js);
    const rrule = composeWeeklyRule([code], parsed.hour, parsed.minute);
    return {
      ok: true,
      patch: { schedule: { kind: 'rrule', rrule, tz: src.tz }, version: src.version },
      interpretation: `Every ${dayName(code)} at ${fmtTime(parsed.hour, parsed.minute)} (${src.tz}) — moves all future occurrences`,
      warnings: ['Moves the whole series, not one occurrence.'],
    };
  }
  // MONTHLY.
  if (drop.d < 1 || drop.d > 28) {
    return refuse('unsupported', `The ${drop.d}th would silently skip short months — drop on the 1st–28th, or edit in Tasks.`);
  }
  const rrule = composeMonthlyRule(drop.d, parsed.hour, parsed.minute);
  return {
    ok: true,
    patch: { schedule: { kind: 'rrule', rrule, tz: src.tz }, version: src.version },
    interpretation: `Monthly on the ${drop.d} at ${fmtTime(parsed.hour, parsed.minute)} (${src.tz}) — moves all future occurrences`,
    warnings: ['Moves the whole series, not one occurrence.'],
  };
}
