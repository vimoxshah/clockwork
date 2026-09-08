/**
 * The guard that runs BEFORE rrule (SCH-2).
 *
 * Two hazards, and the difference between them is the whole reason this file
 * exists. `slow_anchor` is a latency cliff: the answer arrives, late. The
 * `unreachable` shapes do not arrive at all — verified out-of-process on
 * 2026-09-08 with a 12-second watchdog, `FREQ=HOURLY;INTERVAL=2;BYHOUR=3` and a
 * 10:07-anchored `FREQ=MINUTELY;INTERVAL=15;BYMINUTE=0,15,30,45` were both
 * killed at 12s with AND without a DTSTART, while their reachable controls
 * answered in ~11ms. So the guard is not allowed to reach rrule to decide, and
 * the timing assertions below are the proof that it did not.
 */
import { describe, it, expect } from 'vitest';
import { guardSchedule } from '../src/schedule-guard.js';

const MAX = 100_000;
const guard = (rrule: string): ReturnType<typeof guardSchedule> => guardSchedule('rrule', rrule, MAX);

describe('unreachable BY parts — the hang, refused by arithmetic', () => {
  it('FREQ=HOURLY;INTERVAL=2;BYHOUR=3 is unreachable, and answering takes no measurable time', () => {
    const t0 = performance.now();
    const verdict = guard('FREQ=HOURLY;INTERVAL=2;BYHOUR=3');
    const elapsed = performance.now() - t0;
    expect(verdict).toMatchObject({ safe: false, reason: 'unreachable' });
    // The rule itself hangs forever inside rrule. Anything near instant proves
    // the guard decided from the string, not from an expansion.
    expect(elapsed).toBeLessThan(100);
  });

  it('a DTSTART does not rescue it — the guard refuses that shape too', () => {
    expect(guard('DTSTART:20260901T000000Z\nFREQ=HOURLY;INTERVAL=2;BYHOUR=3'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('an off-grid DTSTART makes a quarter-hourly rule unreachable on the MINUTE axis', () => {
    // 10:07 + 15k never lands on :00/:15/:30/:45. Killed at 12s out-of-process.
    const t0 = performance.now();
    const verdict = guard(
      'DTSTART:20260908T100700Z\nFREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45',
    );
    expect(verdict).toMatchObject({ safe: false, reason: 'unreachable' });
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('refuses the whole MINUTELY-plus-day-filter combination, conservatively', () => {
    // Honest about what this one is: the same rule anchored at midnight on a
    // TUESDAY answers in 26ms, so this IS a false positive for that anchor.
    // Whether it terminates depends on the anchor's weekday against the day
    // filter and the hour skip, which is not derivable the way the modular
    // check is — and the rule DOES hang for BYDAY=MO, for BYDAY=SA, and for
    // MO..FR from a Saturday window. Refusing the combination costs nothing a
    // user can reach: the composer emits FREQ=HOURLY.
    expect(guard(
      'DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45',
    )).toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('the FREQ=HOURLY spelling of the same schedule is safe', () => {
    expect(guard('FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;BYDAY=SA;BYHOUR=9,10;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55'))
      .toEqual({ safe: true });
  });

  it('a coarser BY part is checked on the WALK\'s grid, not on its own field', () => {
    // The hole this closes. A MINUTELY rule has no hour counter: it walks
    // minutes and re-tests BYHOUR at each one, so reachability is a question
    // about minutes-of-day. Every row below was verified out of process against
    // rrule 2.8.1 with a watchdog.
    //
    //   INTERVAL=120 from midnight reaches minutes 0,120,240… and hour 3 is
    //   minutes 180-239, so it never lands — killed at 457 SECONDS.
    expect(guard('DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=120;BYHOUR=3'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
    expect(guard('DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=1440;BYHOUR=10'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
    expect(guard('DTSTART:20260908T000000Z\nFREQ=SECONDLY;INTERVAL=120;BYMINUTE=1'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('and the neighbouring interval that DOES land is left alone', () => {
    // gcd(90, 1440) = 90, and 180 is a multiple of 90, so minute 180 — the
    // first minute of hour 3 — is on the walk. Measured: 15ms, answers.
    // A blanket ban on MINUTELY+BYHOUR would have refused this.
    expect(guard('DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=90;BYHOUR=3')).toEqual({ safe: true });
    // gcd(60, 1440) = 60: every hour boundary is on the walk.
    expect(guard('DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=60;BYHOUR=3')).toEqual({ safe: true });
    // Any interval that does not divide the day reaches every minute of it.
    expect(guard('DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=7;BYHOUR=3;BYMINUTE=0')).toEqual({ safe: true });
  });

  it('reachable hours pass: INTERVAL=2 reaches even hours', () => {
    expect(guard('FREQ=HOURLY;INTERVAL=2;BYHOUR=4')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;INTERVAL=3;BYHOUR=9')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;INTERVAL=1;BYHOUR=9')).toEqual({ safe: true });
  });

  it('reachability is measured from the anchor, not from midnight', () => {
    // Anchored at 01:00, INTERVAL=2 reaches ODD hours — so 3 is fine and 4 is not.
    expect(guard('DTSTART:20260901T010000Z\nFREQ=HOURLY;INTERVAL=2;BYHOUR=3')).toEqual({ safe: true });
    expect(guard('DTSTART:20260901T010000Z\nFREQ=HOURLY;INTERVAL=2;BYHOUR=4'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });
});

describe('the epoch-anchor cliff — slow, and only without a DTSTART', () => {
  it('an off-grid INTERVAL with a coarser BY part and no DTSTART is the cliff', () => {
    // 60 % 7 !== 0, so `skipStaysOnGrid` fails and the anchor stays at 1970 —
    // recurrence.ts's own `FREQ=MINUTELY;INTERVAL=7;BYHOUR=5` case. It is
    // REACHABLE (gcd(7,1440)=1 reaches every minute), so it falls through the
    // hang check to this one: slow, not infinite, and the two must not be
    // reported as the same thing.
    expect(guard('FREQ=MINUTELY;INTERVAL=7;BYHOUR=5'))
      .toMatchObject({ safe: false, reason: 'slow_anchor' });
  });

  it('a whole-day filter is the harder refusal and wins over the cliff', () => {
    expect(guard('FREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('without a whole-day filter the anchor advances, so no DTSTART is needed', () => {
    // `skipStaysOnGrid` holds: 60 % 15 === 0 and nothing rejects a whole day.
    expect(guard('FREQ=MINUTELY;INTERVAL=15;BYHOUR=9,10;BYMINUTE=0,15,30,45')).toEqual({ safe: true });
  });

  it('COUNT pins a sub-daily rule to the epoch anchor whatever else it states', () => {
    expect(guard('FREQ=MINUTELY;INTERVAL=15;COUNT=500;BYMINUTE=0,15,30,45'))
      .toMatchObject({ safe: false, reason: 'slow_anchor' });
  });

  it('daily and coarser are never subject to the cliff', () => {
    expect(guard('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toEqual({ safe: true });
    expect(guard('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0')).toEqual({ safe: true });
    expect(guard('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0')).toEqual({ safe: true });
  });
});

describe('the COUNT ceiling, mirrored from save', () => {
  it('refuses a COUNT above the limit', () => {
    expect(guard(`FREQ=DAILY;COUNT=${MAX + 1};BYHOUR=9`))
      .toMatchObject({ safe: false, reason: 'count_too_large' });
  });
  it('accepts one at the limit', () => {
    expect(guard(`FREQ=DAILY;COUNT=${MAX};BYHOUR=9`)).toEqual({ safe: true });
  });
});

describe('what the guard deliberately does not judge', () => {
  it('cron and once never reach it', () => {
    expect(guardSchedule('cron', null, MAX)).toEqual({ safe: true });
    expect(guardSchedule('once', null, MAX)).toEqual({ safe: true });
  });
  it('an empty or FREQ-less rule is unparseable, not silently safe', () => {
    expect(guard('')).toMatchObject({ safe: false, reason: 'unparseable' });
    expect(guard('BYHOUR=9')).toMatchObject({ safe: false, reason: 'unparseable' });
  });
  it('a degenerate INTERVAL is left to the path that already handles it', () => {
    expect(guard('FREQ=MINUTELY;INTERVAL=0;BYHOUR=9')).toEqual({ safe: true });
  });
});
