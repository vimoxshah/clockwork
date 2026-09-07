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
 *     the shapes whose phase lives in DTSTART, and every shape carrying COUNT,
 *     must still anchor at 1970-01-01T00:00:00Z.
 *  2. THE OCCURRENCE SET DOES NOT CHANGE. This module owns DST correctness
 *     (S-20/S-21), so "faster" is worthless without "identical". The oracle is
 *     the module itself: a rule text that ALREADY carries
 *     `DTSTART:19700101T000000Z` is left alone by construction, so passing the
 *     old anchor explicitly reproduces the old code path exactly — same wall
 *     window, same padding, same `wallTimeToUtcMs` DST resolution. Every shape
 *     below is expanded both ways and the two lists must be equal, including
 *     the shapes that fall back, where "equal" is what proves the fallback
 *     still fires.
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

const MINUTE_MS = 60_000;
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

afterEach(() => {
  // A leaked patch would silently corrupt every later test in this worker.
  expect(RRule.prototype.between, 'the anchor probe must never outlive its test').toBe(realBetween);
});

// ---------------------------------------------------------------- rule corpus

/**
 * Shapes the advance is claimed safe for: an explicit phase (BYHOUR+BYMINUTE
 * for DAILY, BYDAY for WEEKLY, BYMONTHDAY for MONTHLY) and no COUNT.
 */
const ADVANCED_SHAPES = [
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
 * Shapes that must keep the 1970 anchor. Two different reasons: COUNT changes
 * WHICH occurrences exist at all (dropping the early ones hands the count to
 * later ones), while the rest let DTSTART supply the phase — the time of day,
 * the weekday, the day of the month — so the module refuses to touch them.
 */
const FALLBACK_SHAPES = [
  'FREQ=DAILY',
  'FREQ=DAILY;BYHOUR=9', // no BYMINUTE
  'FREQ=DAILY;BYMINUTE=0', // no BYHOUR
  'FREQ=DAILY;INTERVAL=2',
  'FREQ=DAILY;INTERVAL=0;BYHOUR=9;BYMINUTE=0', // degenerate interval: no occurrences, ever
  'FREQ=WEEKLY;BYHOUR=14;BYMINUTE=30', // no BYDAY
  'FREQ=WEEKLY',
  'FREQ=MONTHLY;BYHOUR=6;BYMINUTE=0', // no BYMONTHDAY
  'FREQ=MONTHLY;BYDAY=1MO;BYHOUR=6',
  'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=6;BYMINUTE=0',
  'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;COUNT=1;BYHOUR=12',
  'FREQ=WEEKLY;COUNT=200;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
  'FREQ=DAILY;INTERVAL=2;COUNT=20000;BYHOUR=9;BYMINUTE=0',
  'FREQ=MONTHLY;COUNT=700;BYMONTHDAY=15;BYHOUR=6;BYMINUTE=0',
] as const;
// NOT in that list, deliberately: FREQ=DAILY;INTERVAL=-1. rrule 2.8.1 spins
// forever on it inside between() with ANY anchor, so executing it here would
// hang the suite. The interval guard routes it to the untouched epoch path,
// which leaves that pre-existing behaviour exactly as it is.

/** The two windows every shape is checked over: the calendar's and the scheduler's. */
const WIDE_WINDOWS: Array<readonly [string, number, number]> = [
  ['calendar month view', ANCHOR, ANCHOR + 31 * DAY_MS],
  ['next-fire horizon (732d)', ANCHOR, ANCHOR + 732 * DAY_MS],
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
  it('a DAILY rule with an explicit BYHOUR+BYMINUTE lands within days of the window', () => {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo'] as const) {
      for (const rule of ['FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0']) {
        const label = `${rule} @ ${zone}`;
        const anchor = anchorFor(rule, zone, ANCHOR, ANCHOR + 31 * DAY_MS);
        expect(anchor, `${label}: still replaying from the epoch`).toBeGreaterThan(Date.UTC(2020, 0, 1));
        // Below the padded lower bound — 25h of DST slack, plus a whole period
        // of deliberate backoff, plus the zone offset — and never far below it.
        expect(anchor, `${label}: must not overshoot into the window`).toBeLessThanOrEqual(ANCHOR);
        expect(ANCHOR - anchor, `${label}: must stay within a few periods of the window`).toBeLessThan(4 * DAY_MS);
        expect(anchor % DAY_MS, `${label}: a whole number of days off the epoch`).toBe(0);
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

  it('the shapes whose phase lives in DTSTART, and every COUNT shape, keep the 1970 anchor', () => {
    for (const rule of FALLBACK_SHAPES) {
      expect(anchorFor(rule, 'UTC', ANCHOR, ANCHOR + 31 * DAY_MS), `${rule}: must NOT be advanced`).toBe(EPOCH_ANCHOR_MS);
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

  it('an HOURLY rule falls back, and expands identically near the epoch', () => {
    // Near the epoch on purpose. A DTSTART-less HOURLY rule falls back to the
    // 1970 anchor, and over a 2026 window that replay is ~490k iterations —
    // measured at 635.60ms for ONE such schedule on 2026-09-07 (Apple M4).
    // That is the residual of this fix, not part of it: the advance is claimed
    // only for DAILY/WEEKLY/MONTHLY, so an hourly booking still pays the full
    // replay and a DTSTART-less MINUTELY one still cannot be expanded at all.
    const rule = 'FREQ=HOURLY;BYMINUTE=45';
    for (const zone of ['UTC', 'America/New_York'] as const) {
      const from = utc(1971, 3, 9, 7);
      const to = from + 2 * DAY_MS;
      expect(anchorFor(rule, zone, from, to)).toBe(EPOCH_ANCHOR_MS);
      expect(withSyntheticAnchor(rule, zone, from, to).map(iso)).toEqual(withEpochAnchor(rule, zone, from, to).map(iso));
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
  function replayRatio(rule: string, from: number, to: number): { ratio: number; bare: number; control: number } {
    const bare: ScheduleLike = { kind: 'rrule', rrule: rule, tz: 'UTC' };
    const control: ScheduleLike = { kind: 'rrule', rrule: `DTSTART:20260101T000000Z\nRRULE:${rule}`, tz: 'UTC' };
    const b = fastest(9, () => occurrencesBetween(bare, from, to, 62));
    const c = fastest(9, () => occurrencesBetween(control, from, to, 62));
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

  it('a one-minute tick window is unaffected by the anchor it was given', () => {
    // The tick loop's own shape: a tiny window, asked again 30 seconds later,
    // forever. This is the call the replay taxed hardest, because the replay is
    // a fixed cost and the window is one minute wide.
    const r = replayRatio('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', ANCHOR, ANCHOR + MINUTE_MS);
    console.info(`[t307] one-minute tick window: ${r.bare.toFixed(3)}ms vs ${r.control.toFixed(3)}ms = ${r.ratio.toFixed(1)}x`);
    expect(r.ratio).toBeLessThan(10);
  });
});
