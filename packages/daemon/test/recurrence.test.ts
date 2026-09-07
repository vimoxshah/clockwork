/**
 * Recurrence window/limit semantics (T-103, arch §4, FR-4).
 *
 * These pin what `limit` MEANS: the EARLIEST `limit` occurrences in the window,
 * not the last ones. `nextOccurrenceAfter` asks for one occurrence and takes
 * `found[0]`, so a suffix slice hands it the far end of the 732-day horizon and
 * every RRULE task fires ~2 years late instead of tomorrow.
 *
 * They also pin the half-open window the docstring promises —
 * `(fromMsExcl, toMsIncl]` in INSTANT space. That bound is what stops the
 * scheduler wedging: it calls `nextOccurrenceAfter(s, max(fireAt, now))`, and an
 * inclusive lower bound answers `fireAt` itself, whose ledger row is already
 * claimed, so `next_fire` would never advance again.
 */
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { occurrencesBetween, nextOccurrenceAfter, type ScheduleLike } from '../src/recurrence.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 2026-03-07T12:00:00Z — the same anchor scheduler.test.ts uses for its fake clock. */
const ANCHOR = DateTime.fromObject({ year: 2026, month: 3, day: 7, hour: 12 }, { zone: 'utc' }).toMillis();

function utc(y: number, mo: number, d: number, h: number, mi = 0): number {
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi }, { zone: 'utc' }).toMillis();
}

function inZone(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi }, { zone }).toMillis();
}

const iso = (ms: number): string => new Date(ms).toISOString();

const dailyAt2Utc: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0', tz: 'UTC' };

describe('nextOccurrenceAfter — the FIRST occurrence after the instant, not the last in the horizon', () => {
  it('a daily rule fires tomorrow, not two years out', () => {
    // ANCHOR is 12:00Z; the rule fires 02:00Z, so the next fire is TOMORROW 02:00Z.
    const next = nextOccurrenceAfter(dailyAt2Utc, ANCHOR);
    expect(next).not.toBeNull();
    expect(iso(next!)).toBe('2026-03-08T02:00:00.000Z');
    expect(next! - ANCHOR).toBeLessThan(DAY_MS); // never the far end of the 732-day horizon
  });

  it('a weekly rule advances exactly one week — across the Berlin spring-forward (S-20)', () => {
    // Sundays 09:30 Europe/Berlin. Mar 22 is CET (+1); Mar 29 is the transition
    // day and is already CEST (+2) at 09:30, so the next fire is 7 days MINUS an
    // hour of wall clock later, and its local time is still 09:30.
    const weekly: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=30', tz: 'Europe/Berlin' };
    const fireAt = inZone(2026, 3, 22, 9, 30, 'Europe/Berlin');
    const expected = inZone(2026, 3, 29, 9, 30, 'Europe/Berlin');

    const next = nextOccurrenceAfter(weekly, fireAt + 1000);
    expect(next).not.toBeNull();
    expect(iso(next!)).toBe(iso(expected));
    expect(next! - fireAt).toBe(7 * DAY_MS - HOUR_MS); // the DST hour, not a naive +7d
    const local = DateTime.fromMillis(next!, { zone: 'Europe/Berlin' });
    expect(local.hour).toBe(9);
    expect(local.minute).toBe(30);
  });

  it('never returns the occurrence it was handed — the scheduler advances next_fire or wedges', () => {
    // scheduler.ts calls nextOccurrenceAfter(s, Math.max(fireAt, now)) with
    // fireAt being an occurrence instant. Returning fireAt again means the
    // ledger claim fails forever and the schedule stops firing.
    const cases: Array<{ label: string; s: ScheduleLike; fireAt: number; expected: number }> = [
      {
        label: 'UTC daily',
        s: dailyAt2Utc,
        fireAt: utc(2026, 3, 8, 2),
        expected: utc(2026, 3, 9, 2),
      },
      {
        label: 'Asia/Tokyo daily (+09, occurrence sits on the UTC day boundary)',
        s: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'Asia/Tokyo' },
        fireAt: inZone(2026, 3, 10, 9, 0, 'Asia/Tokyo'),
        expected: inZone(2026, 3, 11, 9, 0, 'Asia/Tokyo'),
      },
      {
        label: 'America/New_York daily',
        s: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'America/New_York' },
        fireAt: inZone(2026, 3, 10, 9, 0, 'America/New_York'),
        expected: inZone(2026, 3, 11, 9, 0, 'America/New_York'),
      },
      {
        label: 'Europe/Berlin weekly',
        s: { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=15', tz: 'Europe/Berlin' },
        fireAt: inZone(2026, 4, 6, 7, 15, 'Europe/Berlin'),
        expected: inZone(2026, 4, 13, 7, 15, 'Europe/Berlin'),
      },
    ];
    for (const c of cases) {
      const next = nextOccurrenceAfter(c.s, c.fireAt);
      expect(next, c.label).not.toBeNull();
      expect(next!, `${c.label}: must be strictly after the occurrence it was given`).toBeGreaterThan(c.fireAt);
      expect(iso(next!), c.label).toBe(iso(c.expected));
    }
  });

  it('a COUNT-exhausted rule still returns null so S-24 auto-disable keeps working', () => {
    const counted: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=1;BYHOUR=12', tz: 'UTC' };
    // COUNT=1 against a 1970 anchor: the single occurrence is 1970-01-01, long gone.
    expect(nextOccurrenceAfter(counted, ANCHOR)).toBeNull();
    const withStart: ScheduleLike = {
      kind: 'rrule',
      rrule: 'DTSTART:20260310T120000Z\nRRULE:FREQ=DAILY;COUNT=2',
      tz: 'UTC',
    };
    // Two occurrences: Mar 10 and Mar 11. Ask after each.
    expect(iso(nextOccurrenceAfter(withStart, ANCHOR)!)).toBe('2026-03-10T12:00:00.000Z');
    expect(iso(nextOccurrenceAfter(withStart, utc(2026, 3, 10, 12))!)).toBe('2026-03-11T12:00:00.000Z');
    expect(nextOccurrenceAfter(withStart, utc(2026, 3, 11, 12))).toBeNull(); // exhausted → auto-disable
  });

  it('cron schedules are unaffected — that branch already returned an ordered prefix', () => {
    const cron: ScheduleLike = { kind: 'cron', cron: '0 2 * * *', tz: 'UTC' };
    expect(iso(nextOccurrenceAfter(cron, ANCHOR)!)).toBe('2026-03-08T02:00:00.000Z');
  });
});

describe('occurrencesBetween — half-open window, earliest-N limit', () => {
  it('excludes the lower bound: (fromMsExcl, toMsIncl] as the docstring promises', () => {
    const fireAt = utc(2026, 3, 8, 2);
    const got = occurrencesBetween(dailyAt2Utc, fireAt, fireAt + 5 * DAY_MS, 1000);
    expect(got).not.toContain(fireAt);
    expect(got.map(iso)).toEqual([
      '2026-03-09T02:00:00.000Z',
      '2026-03-10T02:00:00.000Z',
      '2026-03-11T02:00:00.000Z',
      '2026-03-12T02:00:00.000Z',
      '2026-03-13T02:00:00.000Z',
    ]);
  });

  it('includes the upper bound', () => {
    const from = utc(2026, 3, 8, 2);
    const to = utc(2026, 3, 10, 2);
    expect(occurrencesBetween(dailyAt2Utc, from, to, 1000).map(iso)).toEqual([
      '2026-03-09T02:00:00.000Z',
      '2026-03-10T02:00:00.000Z',
    ]);
  });

  it('limit takes the EARLIEST N in the window, not the last N', () => {
    // Explicit DTSTART keeps the 1970 replay out of an hourly rule.
    const hourly: ScheduleLike = { kind: 'rrule', rrule: 'DTSTART:20260301T000000Z\nRRULE:FREQ=HOURLY', tz: 'UTC' };
    const from = utc(2026, 3, 7, 12);
    const got = occurrencesBetween(hourly, from, from + DAY_MS, 3);
    expect(got.map(iso)).toEqual([
      '2026-03-07T13:00:00.000Z',
      '2026-03-07T14:00:00.000Z',
      '2026-03-07T15:00:00.000Z',
    ]);
  });

  it('the rrule and cron branches agree on the same schedule, window and limit', () => {
    // Same daily 02:00 UTC schedule expressed both ways, with `from` sitting
    // exactly ON an occurrence so the lower-bound rule is what is under test.
    const from = utc(2026, 3, 7, 2);
    const to = from + 5 * DAY_MS;
    const asRrule = occurrencesBetween(dailyAt2Utc, from, to, 1000);
    const asCron = occurrencesBetween({ kind: 'cron', cron: '0 2 * * *', tz: 'UTC' }, from, to, 1000);
    expect(asRrule.map(iso)).toEqual(asCron.map(iso));
    expect(asRrule).toHaveLength(5);
  });

  it('a one-off is unchanged: strictly after `from`, up to and including `to`', () => {
    const at = utc(2026, 3, 9, 5);
    const once: ScheduleLike = { kind: 'once', runAt: at, tz: 'UTC' };
    expect(occurrencesBetween(once, at - 1, at, 500)).toEqual([at]);
    expect(occurrencesBetween(once, at, at + DAY_MS, 500)).toEqual([]);
  });

  it('returns ascending, de-duplicated instants', () => {
    const got = occurrencesBetween(dailyAt2Utc, ANCHOR, ANCHOR + 10 * DAY_MS, 500);
    expect(got).toHaveLength(new Set(got).size);
    expect([...got].sort((a, b) => a - b)).toEqual(got);
  });
});

describe('calendar expansion path (/calendar, limit 62) is unchanged', () => {
  // The bench corpus shapes (workforce-bench.test.ts:395) over the route's
  // forward window. Both produce well under 62 occurrences, so earliest-62 and
  // last-62 are the same list — proved here against an independently computed
  // expectation rather than a snapshot of the old behaviour.
  const from = ANCHOR;
  const to = ANCHOR + 31 * DAY_MS;

  function expectedDaily(hour: number): string[] {
    const out: string[] = [];
    for (let d = 0; d <= 32; d++) {
      const at = DateTime.fromMillis(from, { zone: 'utc' }).startOf('day').plus({ days: d, hours: hour }).toMillis();
      if (at > from && at <= to) out.push(iso(at));
    }
    return out;
  }

  it('FREQ=DAILY;BYHOUR=9 renders every day in the window', () => {
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'UTC' };
    const got = occurrencesBetween(s, from, to, 62).map(iso);
    expect(got).toEqual(expectedDaily(9));
    expect(got).toHaveLength(31);
    // limit is not binding at this window size, so it cannot change the output.
    expect(got).toEqual(occurrencesBetween(s, from, to, 500).map(iso));
  });

  it('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14 renders every Mon/Wed/Fri in the window', () => {
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=0', tz: 'UTC' };
    const expected: string[] = [];
    for (let d = 0; d <= 32; d++) {
      const day = DateTime.fromMillis(from, { zone: 'utc' }).startOf('day').plus({ days: d, hours: 14 });
      if ([1, 3, 5].includes(day.weekday) && day.toMillis() > from && day.toMillis() <= to) {
        expected.push(iso(day.toMillis()));
      }
    }
    const got = occurrencesBetween(s, from, to, 62).map(iso);
    expect(got).toEqual(expected);
    expect(got.length).toBeGreaterThan(12);
    expect(got).toEqual(occurrencesBetween(s, from, to, 500).map(iso));
  });
});

describe('rrule window bounds live in the schedule wall clock, not in UTC', () => {
  // The rrule branch iterates occurrences as fake-UTC Dates whose UTC
  // components ARE the schedule's LOCAL wall clock — `wallTimeToUtcMs` is what
  // turns one into an instant. Bounding `between()` with the UTC components of
  // the window instants instead slides the whole window by the zone offset:
  // west of UTC it swallows the first |offset| hours after `from`, east of UTC
  // it drops the last `offset` hours before `to`.

  it('west of UTC: a 09:00 ET daily materialized at 06:00 ET fires TODAY, not tomorrow', () => {
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'America/New_York' };
    const todayAt9 = inZone(2026, 3, 10, 9, 0, 'America/New_York'); // 13:00Z (EDT)

    // 06:00 ET is 10:00Z. A UTC-read window starts at wall 10:00 and never sees
    // wall 09:00, so the next fire skipped a 09:00 that is three hours away.
    expect(iso(nextOccurrenceAfter(s, inZone(2026, 3, 10, 6, 0, 'America/New_York'))!)).toBe(iso(todayAt9));
    // The two neighbours that were already correct must stay correct.
    expect(iso(nextOccurrenceAfter(s, inZone(2026, 3, 10, 3, 0, 'America/New_York'))!)).toBe(iso(todayAt9));
    expect(iso(nextOccurrenceAfter(s, inZone(2026, 3, 10, 10, 0, 'America/New_York'))!)).toBe(
      iso(inZone(2026, 3, 11, 9, 0, 'America/New_York')),
    );
  });

  it('west of UTC: the whole offset-wide band after `from` is enumerated, not skipped', () => {
    // /calendar asks for a forward window starting at "now". With `now` inside
    // the band [midnight local, midnight local + |offset|) a UTC-read window
    // loses the first day of every booking series in the zone.
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'America/New_York' };
    const from = inZone(2026, 3, 10, 6, 0, 'America/New_York');
    const to = from + 3 * DAY_MS;
    expect(occurrencesBetween(s, from, to, 62).map(iso)).toEqual([
      iso(inZone(2026, 3, 10, 9, 0, 'America/New_York')),
      iso(inZone(2026, 3, 11, 9, 0, 'America/New_York')),
      iso(inZone(2026, 3, 12, 9, 0, 'America/New_York')),
    ]);
  });

  it('east of UTC: the occurrence landing exactly ON the upper bound is kept', () => {
    // (fromMsExcl, toMsIncl] is CLOSED above, so `to` itself belongs to the
    // window. Read in UTC the window ends at wall 00:00 and never reaches the
    // wall 09:00 that produced it.
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'Asia/Tokyo' };
    const from = inZone(2026, 3, 10, 9, 0, 'Asia/Tokyo'); // 2026-03-10T00:00Z
    const to = inZone(2026, 3, 11, 9, 0, 'Asia/Tokyo'); // 2026-03-11T00:00Z
    expect(occurrencesBetween(s, from, to, 500).map(iso)).toEqual([iso(to)]);
  });

  it('a fall-back repeat does not hide occurrences behind the ambiguous upper bound', () => {
    // America/New_York 2026-11-01: 02:00 EDT rewinds to 01:00 EST, so 05:00Z
    // and 06:30Z both read as 01:xx local — a 30-minute WALL window over a
    // 90-minute INSTANT window. The 01:45 occurrence sits above the upper wall
    // bound while its instant (05:45Z, the S-21 first pass) is inside the
    // window, so the wall window has to reach past the repeat and let the exact
    // instant filter do the real bounding. 02:45 local is already EST → 07:45Z,
    // outside the window, and must NOT come back.
    const s: ScheduleLike = {
      kind: 'rrule',
      rrule: 'DTSTART:20261101T000000Z\nRRULE:FREQ=HOURLY;BYMINUTE=45',
      tz: 'America/New_York',
    };
    const from = Date.parse('2026-11-01T05:00:00.000Z');
    const to = Date.parse('2026-11-01T06:30:00.000Z');
    expect(occurrencesBetween(s, from, to, 500).map(iso)).toEqual(['2026-11-01T05:45:00.000Z']);
  });

  it('a spring-forward gap does not hide the occurrence pushed past the LOWER bound', () => {
    // The mirror of the fall-back case, and the reason BOTH bounds are padded.
    // wallTimeToUtcMs resolves a nonexistent local time forward (S-20) and
    // Luxon shifts it by the whole gap, so on 2026-03-08 wall 02:45 lands at
    // 03:45 EDT = 07:45Z while wall 03:00 lands at 07:00Z — wall->instant is
    // NOT monotone across a gap. An occurrence can therefore sit BELOW the
    // lower wall bound with its instant still ahead of `fromMsExcl`: at 03:30
    // EDT the 02:45 fire is fifteen minutes in the future, and bounding on the
    // wall clock alone skips it to the next day.
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=45', tz: 'America/New_York' };
    const at0330edt = Date.parse('2026-03-08T07:30:00.000Z');
    expect(iso(nextOccurrenceAfter(s, at0330edt)!)).toBe('2026-03-08T07:45:00.000Z');
  });

  it('an unresolvable tz degrades exactly as it does today — no throw, no finite instant', () => {
    // NOT a bug fix, a guard pin. Reading the window in the schedule's zone
    // means an unresolvable zone now reaches `between()`, and an Invalid Date
    // bound there would throw instead of degrading. This pins the PRE-EXISTING
    // contract unchanged: wallTimeToUtcMs already yields NaN for such a zone
    // (the `at <= from || at > to` filter cannot reject NaN, so it survives
    // into the result), and /calendar's per-schedule try/catch is what keeps
    // one broken row from taking the month down.
    const s: ScheduleLike = { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', tz: 'Not/AZone' };
    let got: number[] = [];
    expect(() => {
      got = occurrencesBetween(s, ANCHOR, ANCHOR + 5 * DAY_MS, 62);
    }).not.toThrow();
    expect(got.some((n) => Number.isFinite(n))).toBe(false); // never a plausible-but-wrong instant
    expect(() => nextOccurrenceAfter(s, ANCHOR)).not.toThrow();
  });
});
