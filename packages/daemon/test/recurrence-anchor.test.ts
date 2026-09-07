/**
 * The synthetic RRULE anchor (T-307 root cause, FR-4, arch §4).
 *
 * A rule saved without a DTSTART gets one synthesized, because the library
 * would otherwise anchor at construction-time "now" and break historical and
 * fake-clock expansion. The epoch was the stable choice and it is also the
 * whole of T-307's calendar latency: `RRule.between()` replays EVERY occurrence
 * from the anchor forward before it reaches the window, so a 1970 anchor costs
 * 56 years of iteration on every call — measured by this file's own bench below
 * — and grows by another 365 iterations per year on its own.
 *
 * `recurrence.ts` therefore advances the synthetic anchor forward from 1970 by
 * a WHOLE number of INTERVAL periods in the rule's FREQ unit. Two things are
 * under test here, and the second matters more than the first:
 *
 *  1. THE ADVANCE HAPPENS. Pinned white-box, on the DTSTART of the rule
 *     `between()` is actually called on, so the assertion is deterministic
 *     rather than a wall-clock bound. The gate is pinned in the same place:
 *     every shape carrying COUNT, every YEARLY shape, a degenerate INTERVAL and
 *     the sub-daily shapes whose counter walk can leave the INTERVAL grid must
 *     still anchor at 1970-01-01T00:00:00Z.
 *  2. THE OCCURRENCE SET DOES NOT CHANGE. This module owns DST correctness
 *     (S-20/S-21), so "faster" is worthless without "identical". The oracle is
 *     the module itself: a rule text that ALREADY carries
 *     `DTSTART:19700101T000000Z` is left alone by construction, so passing the
 *     old anchor explicitly reproduces the old code path exactly — same wall
 *     window, same padding, same `wallTimeToUtcMs` DST resolution. Every shape
 *     below is expanded both ways and the two lists must be equal, including
 *     the shapes that fall back, where "equal" is what proves the fallback
 *     still fires.
 *
 * WHY THE SUB-DAILY WINDOWS SIT IN 1970. The oracle pays the replay it is the
 * oracle for: one epoch-anchored `FREQ=MINUTELY` expansion over a 2026 window
 * is 79 SECONDS (measured below, and the whole reason the gate was widened), so
 * a 2026 corpus for the sub-daily shapes would time out on the reference side
 * alone. The windows for those shapes therefore sit days after the epoch, where
 * the reference replay is thousands of iterations instead of tens of millions,
 * and the DST equivalence for them is taken at the 1970 America/New_York
 * transitions (1970-04-26 spring-forward, 1970-10-25 fall-back), which are real
 * transitions in tzdb. `wallTimeToUtcMs` — the whole of the S-20/S-21
 * resolution — is FREQ-independent and runs identically on both paths, so what
 * the year of the window changes is the size of the replay, not the DST rule
 * being exercised.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import * as rruleNs from 'rrule';
import { occurrencesBetween, nextOccurrenceAfter, type ScheduleLike } from '../src/recurrence.js';

// Same dual-shape resolution the module under test uses — the probe below
// patches the prototype, so it has to be patching the SAME class object.
const RRule: typeof import('rrule').RRule =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rruleNs as any).RRule ?? (rruleNs as any).default?.RRule;
type ParsedRule = InstanceType<typeof RRule>;

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const EPOCH_ANCHOR_MS = 0;

/** 2026-03-07T12:00:00Z — the anchor scheduler.test.ts and recurrence.test.ts share. */
const ANCHOR = Date.UTC(2026, 2, 7, 12);

const iso = (ms: number): string => new Date(ms).toISOString();
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

// ---------------------------------------------------------------- anchor probe

const realBetween = RRule.prototype.between;

/**
 * The DTSTART of every rule `between()` was actually called on during `fn`, in
 * fake-UTC epoch ms. Patching `between` rather than `fromString` reads the rule
 * that really got iterated, whatever route built it.
 */
function anchorsUsedBy(fn: () => unknown): number[] {
  const seen: number[] = [];
  RRule.prototype.between = function (this: ParsedRule, after: Date, before: Date, inc?: boolean): Date[] {
    seen.push(this.options.dtstart.getTime());
    return realBetween.call(this, after, before, inc);
  };
  try {
    fn();
  } finally {
    RRule.prototype.between = realBetween;
  }
  return seen;
}

/** The one anchor a single `occurrencesBetween` call is entitled to use. */
function anchorFor(rrule: string, tz: string, from: number, to: number): number {
  const used = anchorsUsedBy(() => occurrencesBetween({ kind: 'rrule', rrule, tz }, from, to, 62));
  expect(used, `expansion of ${rrule} must enumerate exactly once`).toHaveLength(1);
  return used[0]!;
}

/**
 * The anchor the module CHOSE, without iterating from it: `between` is replaced
 * by a stub that records the DTSTART and returns nothing, so the gate decision
 * is read without rrule ever walking a single period.
 *
 * This is the only way to pin the gate for a rule rrule 2.8.1 cannot iterate at
 * all. Three of those exist and they are unrelated to this fix:
 *
 *  - `FREQ=DAILY;INTERVAL=-1` walks BACKWARDS out of the calendar. Measured
 *    2026-09-07: 2.45s and zero occurrences from the epoch anchor, on a 1970
 *    window — slow and useless rather than strictly infinite, but not something
 *    to put in a corpus that expands every shape twice.
 *  - `FREQ=HOURLY;INTERVAL=2;BYHOUR=3` spins forever in `DateTime.addHours`'
 *    skip loop, because that loop steps by whole INTERVALs and the hours it can
 *    reach are fixed by `gcd(INTERVAL, 24)` — from an even hour it never sees
 *    an odd one. Every anchor this module may pick is a whole number of
 *    INTERVAL hours off the epoch, so it is in the SAME residue class and hangs
 *    identically: verified hanging from `19700101T000000Z` AND from
 *    `19700104T220000Z`, and answering in 17ms only from a deliberately
 *    off-grid `19700104T230000Z`.
 *  - `FREQ=MINUTELY;BYHOUR=5;BYDAY=MO,TU` hangs from the EPOCH anchor: a
 *    filtered day sends `addMinutes` through `addHours(24, …)`, whose skip loop
 *    then adds 24 hours at a time and can never reach hour 5. Verified hanging
 *    from `19700101T000000Z` and answering in 17ms from `19700104T235900Z` —
 *    which is exactly why the gate refuses it. Advancing it would trade an
 *    upstream hang for an answer this module cannot prove.
 */
function anchorChosenWithoutIterating(rrule: string, tz: string, from: number, to: number): number {
  const seen: number[] = [];
  RRule.prototype.between = function (this: ParsedRule): Date[] {
    seen.push(this.options.dtstart.getTime());
    return [];
  };
  try {
    occurrencesBetween({ kind: 'rrule', rrule, tz }, from, to, 62);
  } finally {
    RRule.prototype.between = realBetween;
  }
  expect(seen, `expansion of ${rrule} must build exactly one rule`).toHaveLength(1);
  return seen[0]!;
}

afterEach(() => {
  // A leaked patch would silently corrupt every later test in this worker.
  expect(RRule.prototype.between, 'the anchor probe must never outlive its test').toBe(realBetween);
});

// ---------------------------------------------------------------- rule corpus

/**
 * Shapes the advance is claimed safe for: DAILY, WEEKLY or MONTHLY, no COUNT.
 *
 * The phase-carrying BY parts are NOT a condition. They were, and the probe
 * that guarded that gate found every implicit-phase shape equivalent anyway,
 * which is what the argument in `advancedAnchorMs` predicts: the anchor is
 * always a whole multiple of the FREQ unit off 1970-01-01T00:00:00, so a
 * whole-day step preserves the time of day DAILY reads off DTSTART, a
 * whole-week step preserves the weekday WEEKLY reads, and a whole-month step
 * from the 1st preserves the day of the month MONTHLY reads. The shapes that
 * used to be refused for an implicit phase are marked `[was refused]` and are
 * held to the same two claims as the rest: the advance happens, and the
 * occurrence set is identical.
 */
const ADVANCED_SHAPES = [
  'FREQ=DAILY', // [was refused] no BYHOUR, no BYMINUTE: midnight comes off DTSTART
  'FREQ=DAILY;BYHOUR=9', // [was refused] no BYMINUTE
  'FREQ=DAILY;BYMINUTE=0', // [was refused] no BYHOUR
  'FREQ=DAILY;INTERVAL=2', // [was refused]
  'FREQ=WEEKLY', // [was refused] the weekday comes off DTSTART (a Thursday)
  'FREQ=WEEKLY;BYHOUR=14;BYMINUTE=30', // [was refused] no BYDAY
  'FREQ=MONTHLY;BYHOUR=6;BYMINUTE=0', // [was refused] no BYMONTHDAY
  'FREQ=MONTHLY;BYDAY=1MO;BYHOUR=6', // [was refused] the day comes from BYDAY, not DTSTART
  'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=6;BYMINUTE=0', // [was refused]
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', // the form the bench corpus stores
  'FREQ=DAILY;BYHOUR=0;BYMINUTE=0',
  'FREQ=DAILY;BYHOUR=23;BYMINUTE=59',
  'FREQ=DAILY;BYHOUR=2;BYMINUTE=45', // inside the America/New_York spring-forward gap
  'FREQ=DAILY;BYHOUR=1;BYMINUTE=45', // inside the America/New_York fall-back repeat
  'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=30',
  'FREQ=DAILY;INTERVAL=7;BYHOUR=6;BYMINUTE=15',
  'FREQ=DAILY;INTERVAL=13;BYHOUR=6;BYMINUTE=15',
  'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=30',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYMONTH=1,3,7',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYMONTHDAY=1,15',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYWEEKNO=10,11', // week/yearday masks are built
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYYEARDAY=66,67', // per year, not off DTSTART
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;WKST=SU',
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260401T000000Z', // UNTIL inside the month window
  'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=19750101T000000Z', // UNTIL below the advanced anchor
  'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSETPOS=1',
  'FREQ=WEEKLY;BYDAY=MO,WE;BYSETPOS=1;BYHOUR=9;BYMINUTE=0',
  'FREQ=MONTHLY;BYMONTHDAY=10,20;BYSETPOS=-1;BYHOUR=6',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30',
  'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=30',
  'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;BYHOUR=8;BYMINUTE=0',
  'FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=3;BYHOUR=8;BYMINUTE=0',
  'FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU;INTERVAL=2;BYHOUR=10;BYMINUTE=0',
  'FREQ=WEEKLY;BYDAY=MO,TH;WKST=WE;INTERVAL=5;BYHOUR=10;BYMINUTE=0',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR', // BYDAY explicit, time of day still off DTSTART
  'FREQ=WEEKLY;BYDAY=TH;INTERVAL=4;BYHOUR=1;BYMINUTE=1',
  'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;UNTIL=20260401T000000Z',
  'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=6;BYMINUTE=0',
  'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=6;BYMINUTE=0',
  'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=6;BYMINUTE=0', // skips the short months
  'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=6;BYMINUTE=0', // last day of the month
  'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10;BYHOUR=6',
  'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10',
  'FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=10;BYHOUR=3',
  'FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR;BYHOUR=13',
  'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0;UNTIL=20301231T000000Z',
] as const;

/**
 * Shapes that must keep the 1970 anchor, and the three reasons:
 *
 *  - COUNT changes WHICH occurrences exist at all — dropping the early ones
 *    hands the count to later ones, and an exhausted rule stops being
 *    exhausted. Load-bearing for S-24 auto-disable, and the negative control
 *    at the bottom of this file shows it really does break when forced. A SMALL
 *    count is cheap anyway (the iterator stops after COUNT occurrences, so
 *    `FREQ=MINUTELY;COUNT=10` is 0.4ms), but a LARGE one on a sub-daily FREQ
 *    replays until it reaches the window: `FREQ=MINUTELY;COUNT=40000000` took
 *    76,646ms for one `nextOccurrenceAfter` over the 8-day rung (2026-09-07,
 *    Apple M4). That is the residual hang, it cannot be fixed by moving the
 *    anchor, and the only lever left is a COUNT ceiling at save time in
 *    `api.ts`.
 *  - a degenerate INTERVAL is the untouched path's problem.
 *  - YEARLY is provably safe to advance — a whole-INTERVAL-year step off
 *    1970-01-01 preserves the month, the day of the month and the time of day,
 *    and the forced-advance probe found it equivalent — but 56 iterations is
 *    not a hazard, so it stays on the path it has always been on.
 */
const FALLBACK_SHAPES = [
  'FREQ=DAILY;INTERVAL=0;BYHOUR=9;BYMINUTE=0', // degenerate interval: no occurrences, ever
  'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;INTERVAL=2;BYMONTH=6;BYMONTHDAY=1;BYHOUR=9',
  'FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;COUNT=1;BYHOUR=12',
  'FREQ=WEEKLY;COUNT=200;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;INTERVAL=2;COUNT=20000;BYHOUR=9;BYMINUTE=0',
  'FREQ=MONTHLY;COUNT=700;BYMONTHDAY=15;BYHOUR=6;BYMINUTE=0',
  'FREQ=HOURLY;COUNT=50;BYMINUTE=30',
  'FREQ=MINUTELY;COUNT=10',
] as const;
// NOT in that list, deliberately: FREQ=DAILY;INTERVAL=-1, which walks backwards
// out of the calendar and is far too slow to expand twice per window. The
// interval guard routes it to the untouched epoch path, and
// `anchorChosenWithoutIterating` pins that without executing it.

/** The two windows every shape is checked over: the calendar's and the scheduler's. */
const WIDE_WINDOWS: Array<readonly [string, number, number]> = [
  ['calendar month view', ANCHOR, ANCHOR + 31 * DAY_MS],
  ['next-fire horizon (732d)', ANCHOR, ANCHOR + 732 * DAY_MS],
];

// ------------------------------------------------------------ sub-daily corpus

/**
 * Below DAILY the counter walk stops being plain arithmetic, so the corpus is
 * split by what `DateTime.add` does with the rule.
 *
 * HOURLY needs no condition at all: `addHours` steps by exactly INTERVAL hours
 * and rechecks BYHOUR at every step, so it can neither leave the INTERVAL grid
 * nor step over a matching point. MINUTELY and SECONDLY carry their overflow
 * through the coarser adder, whose skip loop then re-adds the WHOLE carry for
 * every value the coarser BY part rejects — a whole hour or minute, which is
 * not a whole number of INTERVAL units unless INTERVAL divides 60. So they are
 * admitted only when the coarser BY parts are absent (the skip loop never
 * runs), or when INTERVAL divides 60 and no BY part rejects a whole day (every
 * carry and every skip step is exactly one unit of the coarser field).
 *
 * PICK BY PARTS THAT THE INTERVAL GRID CAN REACH. `FREQ=HOURLY;INTERVAL=2;
 * BYHOUR=3` hangs inside rrule 2.8.1 at every on-grid anchor, because the skip
 * loop steps by whole INTERVALs and can only ever see hours ≡ 0 mod
 * gcd(INTERVAL, 24). The same trap exists for BYMINUTE/BYSECOND under
 * MINUTELY/SECONDLY, mod gcd(INTERVAL, 60). Every BY value below is a multiple
 * of that gcd; a shape that is not will hang this file rather than fail it.
 */
const HOURLY_SHAPES = [
  'FREQ=HOURLY',
  'RRULE:FREQ=HOURLY', // the form the bench corpus stores
  'FREQ=HOURLY;BYMINUTE=45',
  'FREQ=HOURLY;BYMINUTE=0,30;BYSECOND=15',
  'FREQ=HOURLY;INTERVAL=2',
  'FREQ=HOURLY;INTERVAL=3;BYMINUTE=15',
  'FREQ=HOURLY;INTERVAL=5', // 24 % INTERVAL != 0: the hour of day drifts across days
  'FREQ=HOURLY;INTERVAL=7;BYMINUTE=15,45',
  'FREQ=HOURLY;INTERVAL=13;BYSECOND=15',
  'FREQ=HOURLY;INTERVAL=25', // a period longer than a day
  'FREQ=HOURLY;BYHOUR=5,9', // BYHOUR under HOURLY: the skip loop, on grid
  'FREQ=HOURLY;INTERVAL=3;BYHOUR=0,3,6,9,12,15,18,21',
  // BYHOUR with 24 % INTERVAL != 0, so the skip loop crosses midnight to find a
  // match instead of finding one inside the day. This is the cell that separates
  // HOURLY from MINUTELY: `addHours` adds exactly INTERVAL per step and rechecks
  // BYHOUR after each, so crossing a day costs it nothing, while the same shape
  // one FREQ down (`MINUTELY;INTERVAL=7;BYHOUR=5`) is refused below.
  'FREQ=HOURLY;INTERVAL=7;BYHOUR=0,7,14,21',
  'FREQ=HOURLY;BYHOUR=5,9;BYDAY=MO,TU', // a day filter: the `filtered` jump
  'FREQ=HOURLY;INTERVAL=3;BYHOUR=0,3,6;BYMONTHDAY=6,7',
  'FREQ=HOURLY;INTERVAL=5;BYDAY=MO;BYMINUTE=30',
  'FREQ=HOURLY;BYYEARDAY=6,7',
  'FREQ=HOURLY;WKST=SU;BYWEEKNO=2',
  'FREQ=HOURLY;BYSETPOS=1;BYMINUTE=0,30',
  'FREQ=HOURLY;UNTIL=19700107T000000Z',
] as const;

const MINUTELY_SHAPES = [
  'FREQ=MINUTELY',
  'FREQ=MINUTELY;INTERVAL=7', // 60 % INTERVAL != 0, but no coarser BY part
  'FREQ=MINUTELY;INTERVAL=7;BYSECOND=15',
  'FREQ=MINUTELY;INTERVAL=13;BYMINUTE=0,30', // BYMINUTE is its own field, not a carry
  // The same INTERVAL as the refused `MINUTELY;INTERVAL=7;BYHOUR=5`, one field
  // over. BYMINUTE is MINUTELY's OWN field: an unmatched minute is retried by
  // `addMinutes` itself, one INTERVAL at a time, so nothing is re-added whole
  // and 60 % 7 != 0 does not matter. BYHOUR is a COARSER field, retried by
  // `addHours` in whole hours, which is why only that one is refused.
  'FREQ=MINUTELY;INTERVAL=7;BYMINUTE=3',
  'FREQ=MINUTELY;INTERVAL=7;BYDAY=MO,TU', // day filter, no BYHOUR: jump stays on grid
  'FREQ=MINUTELY;INTERVAL=90;BYSECOND=0', // a period longer than an hour
  'FREQ=MINUTELY;BYHOUR=5', // BYHOUR with INTERVAL=1: 60 % 1 == 0
  'FREQ=MINUTELY;INTERVAL=15;BYHOUR=5,9',
  'FREQ=MINUTELY;INTERVAL=30;BYHOUR=5',
  'FREQ=MINUTELY;INTERVAL=20;BYHOUR=5;BYSECOND=30',
  'FREQ=MINUTELY;INTERVAL=10;UNTIL=19700107T000000Z',
] as const;

const SECONDLY_SHAPES = [
  'FREQ=SECONDLY',
  'FREQ=SECONDLY;INTERVAL=15',
  'FREQ=SECONDLY;INTERVAL=7', // 60 % INTERVAL != 0, but no coarser BY part
  'FREQ=SECONDLY;INTERVAL=15;BYSECOND=0,30',
  'FREQ=SECONDLY;INTERVAL=7;BYSECOND=3', // 60 % INTERVAL != 0, but BYSECOND is SECONDLY's own field
  'FREQ=SECONDLY;INTERVAL=20;BYDAY=MO,TU', // day filter, no BYHOUR/BYMINUTE
  // Day filter AND 60 % INTERVAL != 0, so `skipStaysOnGrid` is FALSE — and the
  // shape is still admitted, because the gate consults that flag only when a
  // COARSER BY part is stated. With BYHOUR and BYMINUTE absent, `addSeconds`'
  // carry runs through `addMinutes`/`addHours` with an empty BY list, which
  // breaks on the first try and so adds the carry exactly once. This is the
  // shape that shows the gate's condition is the coarser-BY-part test, not
  // `skipStaysOnGrid` on its own.
  'FREQ=SECONDLY;INTERVAL=7;BYDAY=MO,TU',
  'FREQ=SECONDLY;INTERVAL=90', // a period longer than a minute
  'FREQ=SECONDLY;INTERVAL=30;BYHOUR=5', // 60 % INTERVAL == 0, no day filter
  'FREQ=SECONDLY;INTERVAL=20;BYMINUTE=0,30',
  'FREQ=SECONDLY;INTERVAL=12;BYHOUR=5;BYMINUTE=0,30',
] as const;

/**
 * Sub-daily shapes that must KEEP the 1970 anchor because their walk leaves the
 * INTERVAL grid: the carry into the coarser field is re-added whole for every
 * value the coarser BY part rejects, and a whole hour is not a whole number of
 * 7 minutes. The negative controls at the bottom of this file force the advance
 * on two of them and show the occurrence set really does change.
 *
 * WHAT THESE REFUSALS STILL COST. They keep the 1970 replay, so they keep a
 * share of the latency this file exists to remove. Measured 2026-09-07 (Apple
 * M4), ONE `nextOccurrenceAfter` over the 8-day save-time rung,
 * America/New_York: `FREQ=MINUTELY;INTERVAL=7;BYHOUR=5` 522ms and
 * `FREQ=SECONDLY;INTERVAL=7;BYMINUTE=5` 11,504ms. The second one is a hang by
 * any reasonable standard. It is not fixable here — the whole-period argument
 * is what makes the advance provable and these shapes are the ones it does not
 * cover — so the remaining lever is a refusal at SAVE time, which lives in
 * `api.ts` and not in this module.
 */
const SUB_DAILY_FALLBACK_SHAPES = [
  'FREQ=MINUTELY;INTERVAL=7;BYHOUR=5', // 60 % 7 != 0: the hour carry is re-added whole
  'FREQ=MINUTELY;INTERVAL=13;BYHOUR=5,9',
  'FREQ=SECONDLY;INTERVAL=7;BYMINUTE=5', // 60 % 7 != 0: the minute carry, likewise
  'FREQ=SECONDLY;INTERVAL=7;BYHOUR=5',
] as const;

/**
 * Shapes rrule 2.8.1 cannot iterate, with the anchor the gate must still pick
 * for them. Read with `anchorChosenWithoutIterating`, which is the only way to
 * assert anything about a rule that hangs the library — see that helper for the
 * per-shape evidence. The point of pinning them at all: the gate decision is
 * what decides whether an upstream hang stays exactly where it was.
 */
const UNITERABLE_SHAPES: Array<readonly [string, number, string]> = [
  ['FREQ=DAILY;INTERVAL=-1', EPOCH_ANCHOR_MS, 'the interval guard'],
  ['FREQ=MINUTELY;BYHOUR=5;BYDAY=MO,TU', EPOCH_ANCHOR_MS, 'day filter + BYHOUR: 24-hour skip steps'],
  ['FREQ=SECONDLY;INTERVAL=30;BYMINUTE=5;BYDAY=MO,TU', EPOCH_ANCHOR_MS, 'day filter + BYMINUTE, likewise'],
  // Advanced, and it must be: HOURLY is on the grid whatever its BY parts say,
  // and the hang this shape has from the epoch anchor is in the same residue
  // class as the hang it has from the advanced one. Refusing it would not save
  // it; it would only make the gate wrong about HOURLY. 92h is the ordinary
  // arithmetic for the six-hour window below: its lower bound is 120h, padded
  // back 25h to 95h, floored to the 47th two-hour period and backed off one.
  ['FREQ=HOURLY;INTERVAL=2;BYHOUR=3', 92 * HOUR_MS, 'HOURLY advances; the upstream hang is anchor-invariant'],
];

/**
 * Windows for the sub-daily corpus: days after the epoch, not decades, because
 * the reference expansion replays every period from 1970 (see the file header).
 * Both are far enough out that the advance is not clamped — the padded lower
 * bound has to clear two whole periods, and the widest period here is 25 hours.
 */
const SUB_DAILY_WINDOWS: Array<readonly [string, number, number]> = [
  ['six hours', utc(1970, 1, 6), utc(1970, 1, 6) + 6 * HOUR_MS],
  ['three days', utc(1970, 1, 6), utc(1970, 1, 9)],
];

/** SECONDLY pays the 25h padding at second resolution, so it gets tighter windows. */
const SECONDLY_WINDOWS: Array<readonly [string, number, number]> = [
  ['ten minutes', utc(1970, 1, 6), utc(1970, 1, 6) + 10 * MINUTE_MS],
  ['two hours', utc(1970, 1, 6), utc(1970, 1, 6) + 2 * HOUR_MS],
];

/**
 * Real DST transitions the sub-daily corpus can afford: US DST ran 1970-04-26
 * to 1970-10-25, so both directions exist within a few months of the epoch.
 * Europe/Berlin (from 1980) and Australia/Lord_Howe (from 1981) have none this
 * early, which is why they appear in `DST_CASES` and not here.
 */
const EARLY_DST_CASES: Array<readonly [string, string, number, number]> = [
  ['America/New_York', '1970 spring-forward (S-20 nonexistent local time)', utc(1970, 4, 25, 12), utc(1970, 4, 27, 12)],
  ['America/New_York', '1970 fall-back (S-21 ambiguous local time)', utc(1970, 10, 24, 12), utc(1970, 10, 26, 12)],
];

/**
 * Zone paired with the window that stresses it — a real DST transition in that
 * zone, or a month/leap boundary. Pairing beats the full cross product: a
 * Berlin transition tells you nothing when read in Tokyo, and every reference
 * expansion here pays the full 1970 replay it is being compared against.
 */
const DST_CASES: Array<readonly [string, string, number, number]> = [
  ['America/New_York', 'spring-forward (S-20 nonexistent local time)', utc(2026, 3, 7), utc(2026, 3, 10)],
  ['America/New_York', 'fall-back (S-21 ambiguous local time)', utc(2026, 10, 31), utc(2026, 11, 3)],
  ['Europe/Berlin', 'spring-forward', utc(2026, 3, 28), utc(2026, 3, 30)],
  ['Europe/Berlin', 'fall-back', utc(2026, 10, 24), utc(2026, 10, 26)],
  ['Australia/Lord_Howe', '30-minute transition', utc(2026, 4, 4), utc(2026, 4, 6)],
  ['Australia/Lord_Howe', 'leap day', utc(2028, 2, 27), utc(2028, 3, 2)],
  ['Asia/Tokyo', 'month boundary, east of UTC', utc(2026, 2, 26), utc(2026, 3, 2)],
  ['UTC', 'month boundary', utc(2026, 2, 26), utc(2026, 3, 2)],
];

/**
 * The three claims that make one advanced anchor sound, for any FREQ whose
 * period is a fixed number of milliseconds:
 *
 *  - it moved off the epoch at all (this is what fails before the fix);
 *  - it is BELOW the window, and beside it rather than decades back — the
 *    padded lower bound is 25h back, the schedule's zone can shift the wall
 *    bound by up to another 14h (tzdb's largest offset), and the deliberate
 *    backoff is one more period;
 *  - it is a whole multiple of the FREQ unit off 1970-01-01T00:00:00, which is
 *    the whole equivalence argument: every finer component stays at zero, so
 *    the components `parseOptions` reads off DTSTART cannot move, and the
 *    INTERVAL grid stays a suffix of the old one.
 */
function expectAnchoredBesideWindow(anchor: number, from: number, unitMs: number, label: string): void {
  expect(anchor, `${label}: still replaying from the epoch`).toBeGreaterThan(EPOCH_ANCHOR_MS);
  expect(anchor, `${label}: must not overshoot into the window`).toBeLessThanOrEqual(from);
  expect(from - anchor, `${label}: must stay beside the window`).toBeLessThan(39 * HOUR_MS + 2 * unitMs);
  expect(anchor % unitMs, `${label}: off the INTERVAL grid`).toBe(0);
}

/** The expansion the OLD code produced: an explicit epoch DTSTART is untouched. */
function withEpochAnchor(rrule: string, tz: string, from: number, to: number, limit = 62): number[] {
  return occurrencesBetween({ kind: 'rrule', rrule: `DTSTART:19700101T000000Z\n${rrule}`, tz }, from, to, limit);
}

/** The expansion the NEW code produces: no DTSTART in the text, so one is synthesized. */
function withSyntheticAnchor(rrule: string, tz: string, from: number, to: number, limit = 62): number[] {
  return occurrencesBetween({ kind: 'rrule', rrule, tz }, from, to, limit);
}

// ---------------------------------------------------------------------- tests

describe('the rule between() iterates is anchored beside the window, not at 1970', () => {
  it('a DAILY rule lands within days of the window, phase parts or not', () => {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo'] as const) {
      for (const [rule, unitMs] of [
        ['FREQ=DAILY;BYHOUR=9;BYMINUTE=0', DAY_MS],
        ['RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', DAY_MS],
        ['FREQ=DAILY', DAY_MS], // no phase parts at all: midnight is read off DTSTART
        ['FREQ=DAILY;BYHOUR=9', DAY_MS], // half a phase
        ['FREQ=DAILY;INTERVAL=2', 2 * DAY_MS],
      ] as const) {
        const anchor = anchorFor(rule, zone, ANCHOR, ANCHOR + 31 * DAY_MS);
        expectAnchoredBesideWindow(anchor, ANCHOR, unitMs, `${rule} @ ${zone}`);
        expect(anchor, `${rule} @ ${zone}: not even in the right decade`).toBeGreaterThan(Date.UTC(2020, 0, 1));
      }
    }
  });

  it('an HOURLY, MINUTELY or SECONDLY rule lands a whole number of INTERVAL units off the epoch', () => {
    // The hazard this fix exists for. These windows sit near the epoch to match
    // the equivalence tests below, which have to expand the same shapes from
    // 1970 on the reference side; the modern-window case is the bench at the
    // bottom of this file.
    const [, from, to] = SUB_DAILY_WINDOWS[0]!;
    for (const [rule, unitMs] of [
      ['FREQ=HOURLY', HOUR_MS],
      ['RRULE:FREQ=HOURLY', HOUR_MS],
      ['FREQ=HOURLY;INTERVAL=5', 5 * HOUR_MS],
      ['FREQ=HOURLY;INTERVAL=25', 25 * HOUR_MS],
      ['FREQ=MINUTELY', MINUTE_MS],
      ['FREQ=MINUTELY;INTERVAL=7', 7 * MINUTE_MS],
      ['FREQ=MINUTELY;BYHOUR=5', MINUTE_MS],
      ['FREQ=MINUTELY;INTERVAL=30;BYHOUR=5', 30 * MINUTE_MS],
      // The two cells the equivalence corpus alone cannot pin: an identical
      // occurrence set is exactly what a REFUSAL also produces, so the shapes
      // admitted for a subtle reason need the advance asserted here too.
      // BYMINUTE under MINUTELY is MINUTELY's own field (60 % 7 != 0 is
      // harmless); the SECONDLY shape has a day filter AND 60 % 7 != 0, so it
      // is admitted only because no COARSER BY part is stated.
      ['FREQ=MINUTELY;INTERVAL=7;BYMINUTE=3', 7 * MINUTE_MS],
      ['FREQ=SECONDLY', SECOND_MS],
      ['FREQ=SECONDLY;INTERVAL=15', 15 * SECOND_MS],
      ['FREQ=SECONDLY;INTERVAL=30;BYHOUR=5', 30 * SECOND_MS],
      ['FREQ=SECONDLY;INTERVAL=7;BYDAY=MO,TU', 7 * SECOND_MS],
    ] as const) {
      for (const zone of ['UTC', 'America/New_York'] as const) {
        expectAnchoredBesideWindow(anchorFor(rule, zone, from, to), from, unitMs, `${rule} @ ${zone}`);
      }
    }
  });

  it('a WEEKLY rule with an explicit BYDAY lands on a whole number of INTERVAL weeks', () => {
    for (const [rule, weeks] of [
      ['FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30', 1],
      ['FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;BYHOUR=8;BYMINUTE=0', 2],
      ['FREQ=WEEKLY;BYDAY=MO,TH;WKST=WE;INTERVAL=5;BYHOUR=10;BYMINUTE=0', 5],
    ] as const) {
      const anchor = anchorFor(rule, 'America/New_York', ANCHOR, ANCHOR + 31 * DAY_MS);
      expect(anchor, `${rule}: still replaying from the epoch`).toBeGreaterThan(Date.UTC(2020, 0, 1));
      expect(anchor, `${rule}: must not overshoot into the window`).toBeLessThanOrEqual(ANCHOR);
      expect(ANCHOR - anchor, `${rule}: within a couple of INTERVAL periods`).toBeLessThan(3 * weeks * WEEK_MS);
      // The whole-period shift is the equivalence argument. 1970-01-01 was a
      // Thursday, so every anchor the module may pick is also a Thursday and
      // sits on the same INTERVAL-week grid — which is what keeps an implicit
      // BYDAY (read off DTSTART) and rrule's WKST week alignment unchanged.
      expect(anchor % (weeks * WEEK_MS), `${rule}: off the INTERVAL-week grid`).toBe(0);
      expect(new Date(anchor).getUTCDay(), `${rule}: the epoch weekday must survive`).toBe(4);
    }
  });

  it('a MONTHLY rule with an explicit BYMONTHDAY lands on the first of a month, at midnight', () => {
    for (const [rule, months] of [
      ['FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=6;BYMINUTE=0', 1],
      ['FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10;BYHOUR=6', 2],
      ['FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=10;BYHOUR=3', 7],
    ] as const) {
      const anchor = anchorFor(rule, 'Europe/Berlin', ANCHOR, ANCHOR + 31 * DAY_MS);
      const at = DateTime.fromMillis(anchor, { zone: 'utc' });
      expect(anchor, `${rule}: still replaying from the epoch`).toBeGreaterThan(Date.UTC(2020, 0, 1));
      expect(anchor, `${rule}: must not overshoot into the window`).toBeLessThanOrEqual(ANCHOR);
      // Whole INTERVAL months off 1970-01-01: day 1, midnight, and a month
      // index that is a multiple of INTERVAL. Month length varies, so this is
      // calendar arithmetic and not a fixed number of milliseconds.
      expect(at.day, `${rule}: day of month must stay 1`).toBe(1);
      expect(at.hour + at.minute + at.second + at.millisecond, `${rule}: time of day must stay midnight`).toBe(0);
      expect(((at.year - 1970) * 12 + at.month - 1) % months, `${rule}: off the INTERVAL-month grid`).toBe(0);
    }
  });

  it('every COUNT shape, every YEARLY shape and a degenerate INTERVAL keep the 1970 anchor', () => {
    for (const rule of FALLBACK_SHAPES) {
      expect(anchorFor(rule, 'UTC', ANCHOR, ANCHOR + 31 * DAY_MS), `${rule}: must NOT be advanced`).toBe(EPOCH_ANCHOR_MS);
    }
  });

  it('a sub-daily rule whose counter can leave the INTERVAL grid keeps the 1970 anchor', () => {
    // Near-epoch window: a 2026 one would make the refusal itself cost 79
    // seconds to observe, which is the hazard, not the assertion.
    const [, from, to] = SUB_DAILY_WINDOWS[0]!;
    for (const rule of SUB_DAILY_FALLBACK_SHAPES) {
      for (const zone of ['UTC', 'America/New_York'] as const) {
        expect(anchorFor(rule, zone, from, to), `${rule} @ ${zone}: must NOT be advanced`).toBe(EPOCH_ANCHOR_MS);
      }
    }
  });

  it('the gate decides even for the rules rrule cannot iterate', () => {
    // Read without iterating, because these four hang or crawl inside
    // `between()` — see `anchorChosenWithoutIterating` for the evidence per
    // shape. Pinning them is what keeps an upstream hang exactly where it is
    // instead of quietly moving to a different anchor.
    const [, from, to] = SUB_DAILY_WINDOWS[0]!;
    for (const [rule, expected, why] of UNITERABLE_SHAPES) {
      expect(anchorChosenWithoutIterating(rule, 'UTC', from, to), `${rule}: ${why}`).toBe(expected);
    }
  });

  it("an explicit DTSTART in the rule text is never rewritten — the caller's anchor is authoritative", () => {
    for (const [rule, expected] of [
      ['DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', Date.UTC(2026, 2, 1, 9)],
      ['DTSTART:19700101T000000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', EPOCH_ANCHOR_MS],
      ['DTSTART:20200101T000000Z\nFREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0', Date.UTC(2020, 0, 1)],
      ['dtstart:20260301T090000Z\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', Date.UTC(2026, 2, 1, 9)],
    ] as const) {
      expect(anchorFor(rule, 'UTC', ANCHOR, ANCHOR + 31 * DAY_MS), rule).toBe(expected);
    }
  });

  it('a window at or before the epoch keeps the epoch anchor instead of going negative', () => {
    const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
    expect(anchorFor(rule, 'UTC', utc(1969, 6, 1), utc(1969, 6, 10))).toBe(EPOCH_ANCHOR_MS);
    expect(anchorFor(rule, 'UTC', utc(1970, 1, 1), utc(1970, 1, 4))).toBe(EPOCH_ANCHOR_MS);
    // The rung either side of the clamp, spelled out, because "near the epoch"
    // is where an off-by-one period would hide: a 1970-01-10 window pads its
    // lower bound back 25h to 1970-01-08T23:00, which leaves seven whole days
    // below it, and the deliberate one-period backoff picks the sixth.
    expect(anchorFor(rule, 'UTC', utc(1970, 1, 10), utc(1970, 1, 12))).toBe(utc(1970, 1, 7));
    expect(anchorFor(rule, 'UTC', utc(1970, 1, 3), utc(1970, 1, 5))).toBe(EPOCH_ANCHOR_MS);
  });
});

describe('the advanced anchor generates an IDENTICAL occurrence set', () => {
  it('every shape, over the month view and the 732-day next-fire horizon, in two zones', () => {
    let pairs = 0;
    for (const rule of [...ADVANCED_SHAPES, ...FALLBACK_SHAPES]) {
      for (const zone of ['UTC', 'America/New_York'] as const) {
        for (const [label, from, to] of WIDE_WINDOWS) {
          const want = withEpochAnchor(rule, zone, from, to);
          const got = withSyntheticAnchor(rule, zone, from, to);
          expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
          pairs++;
        }
      }
    }
    expect(pairs).toBe((ADVANCED_SHAPES.length + FALLBACK_SHAPES.length) * 2 * WIDE_WINDOWS.length);
  });

  it('every HOURLY and MINUTELY shape, over two window widths, in two zones', () => {
    let pairs = 0;
    for (const rule of [...HOURLY_SHAPES, ...MINUTELY_SHAPES, ...SUB_DAILY_FALLBACK_SHAPES]) {
      for (const zone of ['UTC', 'America/New_York'] as const) {
        for (const [label, from, to] of SUB_DAILY_WINDOWS) {
          const want = withEpochAnchor(rule, zone, from, to);
          const got = withSyntheticAnchor(rule, zone, from, to);
          expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
          pairs++;
        }
      }
    }
    expect(pairs).toBe(
      (HOURLY_SHAPES.length + MINUTELY_SHAPES.length + SUB_DAILY_FALLBACK_SHAPES.length) * 2 * SUB_DAILY_WINDOWS.length,
    );
  });

  // Its own test, and its own timeout: at second resolution BOTH sides pay the
  // 25h window padding — ~90k occurrences before the window even opens — and
  // the reference side pays the replay from 1970 on top. Measured 20.9s for the
  // 36 pairs on 2026-09-07 (Apple M4); the 120s ceiling is headroom for a
  // slower machine, not a licence to grow the corpus.
  it('every SECONDLY shape, over two window widths, in two zones', { timeout: 120_000 }, () => {
    let pairs = 0;
    for (const rule of SECONDLY_SHAPES) {
      for (const zone of ['UTC', 'America/New_York'] as const) {
        for (const [label, from, to] of SECONDLY_WINDOWS) {
          const want = withEpochAnchor(rule, zone, from, to);
          const got = withSyntheticAnchor(rule, zone, from, to);
          expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
          pairs++;
        }
      }
    }
    expect(pairs).toBe(SECONDLY_SHAPES.length * 2 * SECONDLY_WINDOWS.length);
  });

  it('across a real sub-daily DST transition, in both directions', () => {
    // 1970's America/New_York transitions, because the reference expansion of a
    // per-minute rule from the epoch to a 2026 transition is 29 million
    // iterations. `wallTimeToUtcMs` does not know what year it is; what the
    // early window changes is the size of the replay, not the DST rule.
    const shapes = [
      'FREQ=HOURLY', // an occurrence in the gap and in the repeat, every day
      'FREQ=HOURLY;BYMINUTE=45',
      'FREQ=HOURLY;INTERVAL=3;BYHOUR=0,3,6,9,12,15,18,21',
      'FREQ=MINUTELY;INTERVAL=15',
      'FREQ=MINUTELY;INTERVAL=30;BYHOUR=1,2,3', // straddles the transition hours
      'FREQ=MINUTELY;INTERVAL=7;BYHOUR=5', // a refusal: "identical" means it stayed refused
    ];
    let pairs = 0;
    for (const rule of shapes) {
      for (const [zone, label, from, to] of EARLY_DST_CASES) {
        const want = withEpochAnchor(rule, zone, from, to);
        const got = withSyntheticAnchor(rule, zone, from, to);
        expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
        pairs++;
      }
    }
    expect(pairs).toBe(shapes.length * EARLY_DST_CASES.length);
  });

  it('and at a MODERN transition, where the advance is 56 years wide', () => {
    // One shape, both directions, at the 2026 New York transitions — the case
    // the 1970 windows stand in for. HOURLY only: this is the finest FREQ whose
    // 56-year reference replay (~490k iterations, ~1.3s) fits in a test.
    const rule = 'FREQ=HOURLY;BYMINUTE=45';
    let pairs = 0;
    for (const [zone, label, from, to] of DST_CASES.slice(0, 2)) {
      const want = withEpochAnchor(rule, zone, from, to);
      const got = withSyntheticAnchor(rule, zone, from, to);
      expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
      expect(got.length, `${rule} @ ${zone} / ${label}: an empty window proves nothing`).toBeGreaterThan(24);
      pairs++;
    }
    expect(pairs).toBe(2);
  });

  it('across every DST transition, for the shapes whose fire time sits on one', () => {
    const shapes = [
      'FREQ=DAILY;BYHOUR=2;BYMINUTE=45', // the nonexistent local time (S-20)
      'FREQ=DAILY;BYHOUR=1;BYMINUTE=45', // the ambiguous local time (S-21)
      'FREQ=DAILY;BYHOUR=2;BYMINUTE=30', // Lord Howe's half-hour shift
      'FREQ=DAILY;BYHOUR=0;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30',
      'FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=30',
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=30',
      'FREQ=WEEKLY;BYDAY=SA,SU;WKST=SU;INTERVAL=2;BYHOUR=10;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=6;BYMINUTE=0',
    ];
    let pairs = 0;
    for (const rule of shapes) {
      for (const [zone, label, from, to] of DST_CASES) {
        const want = withEpochAnchor(rule, zone, from, to);
        const got = withSyntheticAnchor(rule, zone, from, to);
        expect(got.map(iso), `${rule} @ ${zone} / ${label}`).toEqual(want.map(iso));
        pairs++;
      }
    }
    expect(pairs).toBe(shapes.length * DST_CASES.length);
  });

  it('nextOccurrenceAfter agrees on every instant the scheduler could hand it', () => {
    // The scheduler calls this with max(fireAt, now), so the instants that
    // matter are on an occurrence, either side of one, and inside a transition.
    const shapes = [
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=2;BYMINUTE=45',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30',
      'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=6;BYMINUTE=0',
      'FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260401T000000Z',
    ];
    const instants = [
      ANCHOR,
      utc(2026, 3, 8, 6, 59), // one minute under the New York spring-forward
      utc(2026, 3, 8, 7, 45),
      utc(2026, 11, 1, 5, 45), // inside the New York fall-back repeat
      utc(2026, 10, 25, 0, 30), // Berlin fall-back
      utc(2028, 2, 29, 6, 0), // leap day
    ];
    let pairs = 0;
    for (const rule of shapes) {
      for (const zone of ['America/New_York', 'Australia/Lord_Howe'] as const) {
        for (const at of instants) {
          const want = nextOccurrenceAfter({ kind: 'rrule', rrule: `DTSTART:19700101T000000Z\n${rule}`, tz: zone }, at);
          const got = nextOccurrenceAfter({ kind: 'rrule', rrule: rule, tz: zone }, at);
          expect(got, `${rule} @ ${zone} after ${iso(at)}`).toBe(want);
          pairs++;
        }
      }
    }
    expect(pairs).toBe(shapes.length * 2 * instants.length);
  });

  it('the earliest-N limit picks the same N', () => {
    for (const rule of [
      'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30',
      'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30',
    ]) {
      for (const limit of [1, 2, 3, 7, 62, 500]) {
        const want = withEpochAnchor(rule, 'Europe/Berlin', ANCHOR, ANCHOR + 31 * DAY_MS, limit);
        const got = withSyntheticAnchor(rule, 'Europe/Berlin', ANCHOR, ANCHOR + 31 * DAY_MS, limit);
        expect(got.map(iso), `${rule} limit=${limit}`).toEqual(want.map(iso));
        expect(got.length, `${rule} limit=${limit}: bound respected`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('an unresolvable zone still degrades to non-finite instants, and still does not throw', () => {
    // The advance reads the window bound, which `wallBoundFor` falls back to
    // UTC for when the zone will not resolve — so the shift DOES happen here.
    // The pre-existing contract (S-26 refuses these at save time, /calendar
    // guards each schedule) is that expansion degrades instead of throwing and
    // never invents a plausible-but-wrong instant.
    const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
    let got: number[] = [];
    expect(() => {
      got = withSyntheticAnchor(rule, 'Not/AZone', ANCHOR, ANCHOR + 5 * DAY_MS);
    }).not.toThrow();
    expect(got.some((n) => Number.isFinite(n))).toBe(false);
    // Compared raw: these are NaN, which has no ISO rendering to compare.
    expect(got).toEqual(withEpochAnchor(rule, 'Not/AZone', ANCHOR, ANCHOR + 5 * DAY_MS));
  });

  it('an HOURLY rule is advanced, and expands identically over the window that used to refuse it', () => {
    // The window this file used to assert the fallback over, kept exactly as it
    // was: same rule, same two zones, same 1971 window. What changed is the
    // anchor it is entitled to use.
    const rule = 'FREQ=HOURLY;BYMINUTE=45';
    for (const zone of ['UTC', 'America/New_York'] as const) {
      const from = utc(1971, 3, 9, 7);
      const to = from + 2 * DAY_MS;
      expectAnchoredBesideWindow(anchorFor(rule, zone, from, to), from, HOUR_MS, `${rule} @ ${zone}`);
      expect(withSyntheticAnchor(rule, zone, from, to).map(iso)).toEqual(withEpochAnchor(rule, zone, from, to).map(iso));
    }
  });
});

describe('the refusals are load-bearing: forcing the advance on one breaks it', () => {
  /**
   * The expansion an anchor the module REFUSED to pick would have produced.
   * Each anchor below is exactly what `advancedAnchorMs` computes for that
   * shape, window and zone with the refusal removed — a whole number of
   * INTERVAL periods off the epoch, one period below the padded lower bound.
   * These are the negative controls: without them "identical" could just mean
   * the gate never fires.
   */
  function withForcedAnchor(rrule: string, tz: string, from: number, to: number, anchorMs: number): number[] {
    const line = DateTime.fromMillis(anchorMs, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss");
    return occurrencesBetween({ kind: 'rrule', rrule: `DTSTART:${line}Z\n${rrule}`, tz }, from, to, 62);
  }

  it('COUNT: advancing hands the count to later occurrences', () => {
    // Five 09:00 fires from 1970-01-01, so the rule is long exhausted by 2026
    // and the window is empty. Anchored at 2026-03-05 it has five fires left.
    const rule = 'FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0';
    const from = ANCHOR;
    const to = ANCHOR + 31 * DAY_MS;
    const refused = withSyntheticAnchor(rule, 'UTC', from, to);
    const forced = withForcedAnchor(rule, 'UTC', from, to, utc(2026, 3, 5));
    expect(refused.map(iso), 'an exhausted COUNT rule must stay exhausted (S-24)').toEqual([]);
    expect(forced.length, 'the forced anchor must resurrect it, or this control proves nothing').toBeGreaterThan(0);
    expect(forced.map(iso)).not.toEqual(refused.map(iso));
  });

  it('MINUTELY with BYHOUR off the grid: advancing changes which minutes fire', () => {
    // 60 % 7 != 0, so `addMinutes` -> `addHours` re-adds the whole hour carry
    // for every hour BYHOUR rejects and the walk drifts off the 7-minute grid:
    // from 00:00 it lands on 05:03, from 22:51 on something else.
    const rule = 'FREQ=MINUTELY;INTERVAL=7;BYHOUR=5';
    const [, from, to] = SUB_DAILY_WINDOWS[0]!;
    const refused = withSyntheticAnchor(rule, 'UTC', from, to);
    const forced = withForcedAnchor(rule, 'UTC', from, to, utc(1970, 1, 4, 22, 51));
    expect(refused.map(iso)).toEqual(withEpochAnchor(rule, 'UTC', from, to).map(iso));
    expect(forced.map(iso), 'the drift must be observable, or the refusal is decorative').not.toEqual(
      refused.map(iso),
    );
  });

  it('SECONDLY with BYMINUTE off the grid: same defect, one field down', () => {
    const rule = 'FREQ=SECONDLY;INTERVAL=7;BYMINUTE=5';
    const [, from, to] = SUB_DAILY_WINDOWS[0]!;
    const refused = withSyntheticAnchor(rule, 'UTC', from, to);
    const forced = withForcedAnchor(rule, 'UTC', from, to, utc(1970, 1, 4, 22, 59) + 52 * SECOND_MS);
    expect(refused.map(iso)).toEqual(withEpochAnchor(rule, 'UTC', from, to).map(iso));
    expect(forced.map(iso)).not.toEqual(refused.map(iso));
  });

  it('the same forcing on an ADMITTED shape changes nothing — the gate is where the danger is', () => {
    // The other half of the control. If forcing an anchor broke expansion in
    // general, the three tests above would prove nothing about the gate.
    for (const [rule, anchor, windowIndex] of [
      ['FREQ=MINUTELY;INTERVAL=30;BYHOUR=5', utc(1970, 1, 4, 22, 30), 1],
      ['FREQ=HOURLY;INTERVAL=5', utc(1970, 1, 4, 18), 1],
      ['FREQ=DAILY;COUNT=20000;BYHOUR=9;BYMINUTE=0', utc(1970, 1, 4), 1], // a COUNT nowhere near exhausted
    ] as const) {
      const [label, from, to] = SUB_DAILY_WINDOWS[windowIndex]!;
      const want = withEpochAnchor(rule, 'UTC', from, to);
      expect(want.length, `${rule} / ${label}: an empty window proves nothing`).toBeGreaterThan(0);
      expect(withForcedAnchor(rule, 'UTC', from, to, anchor).map(iso), rule).toEqual(want.map(iso));
    }
  });
});

describe('what the epoch anchor cost, and what it costs now', () => {
  /** Lowest of `runs` timings — the sample least polluted by the OS scheduler. */
  function fastest(runs: number, fn: () => unknown): number {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  /**
   * A RATIO, not a wall-clock bound. The control is the same rule with a
   * near-window DTSTART, measured in the same process on the same machine, so
   * machine load divides out and what is left is the extra work the synthetic
   * anchor causes. Against a 1970 anchor the tests below measured 189x and
   * 195x for the daily shape, 154x for the weekly and 253-292x for the
   * one-minute window, over two runs on 2026-09-07 (Apple M4); a 10x bound
   * cannot be met by a 56-year replay and cannot be missed by a busy laptop.
   */
  function replayRatio(
    rule: string,
    from: number,
    to: number,
    runs = 9,
  ): { ratio: number; bare: number; control: number } {
    const bare: ScheduleLike = { kind: 'rrule', rrule: rule, tz: 'UTC' };
    const control: ScheduleLike = { kind: 'rrule', rrule: `DTSTART:20260101T000000Z\nRRULE:${rule}`, tz: 'UTC' };
    const b = fastest(runs, () => occurrencesBetween(bare, from, to, 62));
    const c = fastest(runs, () => occurrencesBetween(control, from, to, 62));
    return { ratio: b / c, bare: b, control: c };
  }

  it('a DTSTART-less DAILY rule costs what the same rule with a near-window DTSTART costs', () => {
    const r = replayRatio('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', ANCHOR, ANCHOR + 31 * DAY_MS);
    console.info(
      `[t307] FREQ=DAILY month view: synthetic anchor ${r.bare.toFixed(3)}ms vs near-window DTSTART ` +
        `${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x (189-195x against a 1970 anchor)`,
    );
    expect(r.ratio).toBeLessThan(10);
  });

  it('a DTSTART-less WEEKLY rule does too', () => {
    const r = replayRatio('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=30', ANCHOR, ANCHOR + 31 * DAY_MS);
    console.info(
      `[t307] FREQ=WEEKLY month view: synthetic anchor ${r.bare.toFixed(3)}ms vs near-window DTSTART ` +
        `${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x (154x against a 1970 anchor)`,
    );
    expect(r.ratio).toBeLessThan(10);
  });

  it('the per-year growth is gone: a 2026 window and a 2126 window cost the same', () => {
    // The epoch anchor made expansion cost grow with the calendar — ~365 more
    // iterations per schedule per year, forever. Anchoring beside the window
    // makes the cost a function of the WINDOW instead of of the date.
    const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
    const s: ScheduleLike = { kind: 'rrule', rrule: rule, tz: 'UTC' };
    const soon = fastest(9, () => occurrencesBetween(s, ANCHOR, ANCHOR + 31 * DAY_MS, 62));
    const far = ANCHOR + 100 * 365 * DAY_MS;
    const later = fastest(9, () => occurrencesBetween(s, far, far + 31 * DAY_MS, 62));
    console.info(`[t307] same rule, same window width, a century apart: ${soon.toFixed(3)}ms vs ${later.toFixed(3)}ms`);
    expect(later / soon).toBeLessThan(10);
    // And the anchor really did move with the window, not with the epoch.
    expect(anchorFor(rule, 'UTC', far, far + 31 * DAY_MS)).toBeGreaterThan(far - 4 * DAY_MS);
  });

  it('a DTSTART-less HOURLY rule no longer replays 490,000 periods to answer an 8-day question', () => {
    // The first of the three hazards. Measured 2026-09-07 (Apple M4), ONE
    // `nextOccurrenceAfter` over the 8-day save-time rung, America/New_York:
    // 1,347ms before this gate widened, 2.0ms after.
    const r = replayRatio('FREQ=HOURLY', ANCHOR, ANCHOR + 8 * DAY_MS);
    console.info(
      `[t307] FREQ=HOURLY 8-day window: synthetic anchor ${r.bare.toFixed(3)}ms vs near-window DTSTART ` +
        `${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x (1,347ms against a 1970 anchor)`,
    );
    expect(r.ratio).toBeLessThan(10);
  });

  it('a DTSTART-less MINUTELY rule is answerable at all: it used to take 79 SECONDS', () => {
    // The hazard that made this a hang rather than a slow path. One
    // `nextOccurrenceAfter` over the 8-day save-time rung blocked the API
    // request that saves the task, and the tick that touches the schedule, for
    // 78,941ms (measured 2026-09-07, Apple M4, America/New_York). 87.6ms after.
    //
    // Three runs, not nine: the cost that is left is the window enumeration —
    // 11,520 occurrences over 8 days — and it is paid by BOTH sides of the
    // ratio, which is the point of the ratio.
    const r = replayRatio('FREQ=MINUTELY', ANCHOR, ANCHOR + 8 * DAY_MS, 3);
    console.info(
      `[t307] FREQ=MINUTELY 8-day window: synthetic anchor ${r.bare.toFixed(3)}ms vs near-window DTSTART ` +
        `${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x (78,941ms against a 1970 anchor)`,
    );
    expect(r.ratio).toBeLessThan(10);
    // And a hard ceiling on top of the ratio, because "10x of something awful"
    // is still awful: 8 days of minutes is bounded work now, so this is a
    // regression guard against the anchor creeping back to 1970.
    expect(r.bare).toBeLessThan(5_000);
  });

  it('a SECONDLY rule is anchored beside a MODERN window too', () => {
    // No ratio for this one: at second resolution the 25h window padding alone
    // is ~90k occurrences, so both sides of a ratio would be dominated by
    // enumeration rather than by the anchor. What is asserted instead is the
    // anchor itself, at a 2026 window, which is the thing this fix changes.
    // Before it, this call replayed 1.77 BILLION periods and could not be run.
    const rule = 'FREQ=SECONDLY;INTERVAL=30';
    const took = fastest(1, () => occurrencesBetween({ kind: 'rrule', rrule: rule, tz: 'UTC' }, ANCHOR, ANCHOR + MINUTE_MS, 62));
    const anchor = anchorFor(rule, 'UTC', ANCHOR, ANCHOR + MINUTE_MS);
    console.info(`[t307] FREQ=SECONDLY;INTERVAL=30 one-minute tick window: ${took.toFixed(3)}ms, anchor ${iso(anchor)}`);
    expectAnchoredBesideWindow(anchor, ANCHOR, 30 * SECOND_MS, rule);
    expect(anchor, 'the anchor must be beside the 2026 window, not in 1970').toBeGreaterThan(Date.UTC(2026, 2, 1));
  });

  it('a one-minute tick window is unaffected by the anchor it was given', () => {
    // The tick loop's own shape: a tiny window, asked again 30 seconds later,
    // forever. This is the call the replay taxed hardest, because the replay is
    // a fixed cost and the window is one minute wide.
    const r = replayRatio('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', ANCHOR, ANCHOR + MINUTE_MS);
    console.info(`[t307] one-minute tick window: ${r.bare.toFixed(3)}ms vs ${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x`);
    expect(r.ratio).toBeLessThan(10);
  });
});
