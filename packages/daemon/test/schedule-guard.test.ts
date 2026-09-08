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

  it('anchoring at midnight does NOT rescue it — the day filter is the hazard, not the anchor', () => {
    // Measured 2026-09-08 with an 8s watchdog: the same rule anchored on a
    // Tuesday answered in 15ms and anchored on a SATURDAY hung. A refusal that
    // depended on the anchor would pass on five days a week and hang on two.
    expect(guard(
      'DTSTART:20260908T000000Z\nFREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45',
    )).toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('the FREQ=HOURLY spelling of the same schedule is safe', () => {
    expect(guard('FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;BYDAY=SA;BYHOUR=9,10;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55'))
      .toEqual({ safe: true });
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
    // recurrence.ts's own `FREQ=MINUTELY;INTERVAL=7;BYHOUR=5` case.
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
