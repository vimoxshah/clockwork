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
import { occurrencesBetween } from '../src/recurrence.js';

const MAX = 100_000;
const TZ = 'America/New_York';
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

  it('refuses a sub-daily rule with a coarser BY part instead of analysing it', () => {
    // Every row here was killed by an out-of-process watchdog against rrule
    // 2.8.1, and every one of them was passed by an EARLIER version of this
    // guard. Two models of `addMinutes`'s inner `addHours` skip loop were
    // written and both were wrong:
    //
    //   the 24-hour grid passed  INTERVAL=120;BYHOUR=3      (457 SECONDS)
    //   the minute-of-day grid passed INTERVAL=288;BYHOUR=9,10 and
    //                                 INTERVAL=1441;BYHOUR=3 (both killed at 20s)
    //
    // so the combination is refused outright. No arithmetic, nothing to get
    // wrong a third time.
    const dt = 'DTSTART:20260908T000000Z\n';
    for (const rule of [
      `${dt}FREQ=MINUTELY;INTERVAL=120;BYHOUR=3`,
      `${dt}FREQ=MINUTELY;INTERVAL=288;BYHOUR=9,10`,
      `${dt}FREQ=MINUTELY;INTERVAL=1441;BYHOUR=3`,
      `${dt}FREQ=MINUTELY;INTERVAL=1440;BYHOUR=10`,
      `${dt}FREQ=SECONDLY;INTERVAL=120;BYMINUTE=1`,
      'FREQ=MINUTELY;INTERVAL=15;BYHOUR=9',
    ]) {
      expect(guard(rule), rule).toMatchObject({ safe: false, reason: 'unreachable' });
    }
  });

  it('and says plainly which working rules that costs', () => {
    // These answer in 11-15ms and are refused anyway. Disclosed, not hidden:
    // it is the price of a refusal that cannot be wrong, and nothing the
    // composer emits is in this shape.
    const dt = 'DTSTART:20260908T000000Z\n';
    expect(guard(`${dt}FREQ=MINUTELY;INTERVAL=288;BYHOUR=8`))
      .toMatchObject({ safe: false, reason: 'unreachable' });
    expect(guard(`${dt}FREQ=MINUTELY;INTERVAL=90;BYHOUR=3`))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('leaves a sub-daily rule with no coarser part on its own exact arithmetic', () => {
    // With BYHOUR absent both inner loops break immediately, so the walk really
    // is `anchor + k*INTERVAL (mod 60)` and the gcd is exact.
    const dt = 'DTSTART:20260908T000000Z\n';
    expect(guard(`${dt}FREQ=MINUTELY;INTERVAL=15;BYMINUTE=0,15,30,45`)).toEqual({ safe: true });
    expect(guard(`${dt}FREQ=MINUTELY;INTERVAL=7;BYMINUTE=0`)).toEqual({ safe: true });
    expect(guard('DTSTART:20260908T100700Z\nFREQ=MINUTELY;INTERVAL=15;BYMINUTE=0,15,30,45'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('reachable hours pass: INTERVAL=2 reaches even hours', () => {
    expect(guard('FREQ=HOURLY;INTERVAL=2;BYHOUR=4')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;INTERVAL=3;BYHOUR=9')).toEqual({ safe: true });
    expect(guard('FREQ=HOURLY;INTERVAL=1;BYHOUR=9')).toEqual({ safe: true });
  });

  it('HOURLY reachability is measured from the anchor, and that grid IS exact', () => {
    // Anchored at 01:00, INTERVAL=2 reaches ODD hours — so 3 is fine and 4 is not.
    expect(guard('DTSTART:20260901T010000Z\nFREQ=HOURLY;INTERVAL=2;BYHOUR=3')).toEqual({ safe: true });
    expect(guard('DTSTART:20260901T010000Z\nFREQ=HOURLY;INTERVAL=2;BYHOUR=4'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });
});

describe('the epoch-anchor cliff — slow, and only without a DTSTART', () => {
  it('an off-grid INTERVAL with a same-unit BY part and no DTSTART is the cliff', () => {
    // 60 % 7 !== 0, so `skipStaysOnGrid` fails and the anchor stays at 1970.
    // BYMINUTE is the rule's own unit, so it is not refused as a hang and falls
    // through to this: slow, not infinite. The two must not be reported alike.
    expect(guard('FREQ=MINUTELY;INTERVAL=7;BYMINUTE=5'))
      .toMatchObject({ safe: false, reason: 'slow_anchor' });
  });

  it('a whole-day filter is a hang, not a cliff, and is reported as one', () => {
    expect(guard('FREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10;BYMINUTE=0,15,30,45'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('BYHOUR now decides this before the cliff can, and that is a change', () => {
    // This rule used to be classified safe here: `skipStaysOnGrid` holds
    // (60 % 15 === 0, no whole-day filter) so the anchor advances and it is
    // NOT slow. It is refused now anyway, because BYHOUR on a MINUTELY walk is
    // the shape whose termination could not be modelled correctly twice. A
    // deliberate narrowing, not a regression — and the reason must be the hang
    // one, not the cliff one, or the message would tell the caller to add a
    // DTSTART that will not help.
    expect(guard('FREQ=MINUTELY;INTERVAL=15;BYHOUR=9,10;BYMINUTE=0,15,30,45'))
      .toMatchObject({ safe: false, reason: 'unreachable' });
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

describe('the sweep: no rule the guard passes may fail to terminate', () => {
  /**
   * Two rounds of adversarial review each found a hang by GENERATING rules
   * rather than reasoning about them, and each time the three regression rows
   * added afterwards would not have caught the next one. So the check is the
   * generation, kept in CI.
   *
   * WHAT A FAILURE LOOKS LIKE. A non-terminating rule blocks the event loop, so
   * vitest cannot interrupt it and this file will HANG rather than report a
   * clean assertion failure. That is still a failing run, and it is the only
   * honest way to test for non-termination in-process. If this file ever hangs,
   * the last rule it was building is the witness — narrow `intervals` and
   * re-run.
   *
   * The window is one hour, not the eight days the sweep used out of process:
   * enough for every terminating rule here to answer in single-digit
   * milliseconds, and a rule that does not terminate does not terminate at any
   * width.
   */
  const ANCHORS = ['', 'DTSTART:20260908T000000Z\n', 'DTSTART:20260908T100700Z\n', 'DTSTART:20260908T032959Z\n'];
  const INTERVALS = [1, 2, 5, 7, 15, 30, 60, 61, 90, 120, 288, 359, 720, 1440, 1441, 2880];
  const BY_HOUR = [null, '3', '8', '9,10', '0,12'];
  const BY_MINUTE = [null, '0', '0,30', '0,15,30,45', '7', '13,41', '59'];
  const BY_SECOND = [null, '0', '0,30', '17', '59'];
  const WHOLE_DAY = [null, 'BYDAY=MO', 'BYDAY=MO,TU,WE,TH,FR', 'BYMONTHDAY=15'];

  it('holds across every sub-daily shape a caller can write', () => {
    const FROM = Date.UTC(2026, 8, 8, 12, 0, 0);
    let generated = 0;
    let passed = 0;
    let worstMs = 0;
    for (const anchor of ANCHORS) {
      for (const interval of INTERVALS) {
        for (const wholeDay of WHOLE_DAY) {
          for (const byHour of BY_HOUR) {
            const build = (freq: string, tail: string | null, part: string): string => {
              const parts = [`FREQ=${freq};INTERVAL=${interval}`];
              if (wholeDay) parts.push(wholeDay);
              if (byHour) parts.push(`BYHOUR=${byHour}`);
              if (tail) parts.push(`${part}=${tail}`);
              return anchor + parts.join(';');
            };
            for (const byMinute of BY_MINUTE) {
              const rule = build('MINUTELY', byMinute, 'BYMINUTE');
              generated++;
              if (!guardSchedule('rrule', rule, MAX).safe) continue;
              passed++;
              const t0 = performance.now();
              try { occurrencesBetween({ kind: 'rrule', rrule: rule, tz: TZ }, FROM, FROM + 3_600_000, 5); } catch { /* throwing is fine; hanging is not */ }
              worstMs = Math.max(worstMs, performance.now() - t0);
            }
            for (const bySecond of BY_SECOND) {
              const rule = build('SECONDLY', bySecond, 'BYSECOND');
              generated++;
              if (!guardSchedule('rrule', rule, MAX).safe) continue;
              passed++;
              const t0 = performance.now();
              try { occurrencesBetween({ kind: 'rrule', rrule: rule, tz: TZ }, FROM, FROM + 3_600_000, 5); } catch { /* as above */ }
              worstMs = Math.max(worstMs, performance.now() - t0);
            }
          }
        }
      }
    }
    // Reaching this line at all is the assertion. The rest guards against the
    // sweep quietly generating nothing, or the guard turning into a blanket
    // "refuse everything" that would also make it pass.
    expect(generated).toBeGreaterThan(10_000);
    expect(passed).toBeGreaterThan(300);
    // 5s, not a tight bound: the point of this number is to catch a regression
    // into NON-termination, not to police speed. The slowest terminating rule
    // in the sweep is `FREQ=SECONDLY;INTERVAL=1` — a per-second rule, which
    // genuinely has ~3,600 occurrences to generate for a one-hour window and
    // measured 2.2s out of process and 3.0s under a loaded vitest pool. It is
    // legal, it is not reachable from the composer, and it is slow on its own
    // merits rather than because anything here is wrong. If a per-second rule
    // should be refused outright that is a product call, not a guard bug.
    expect(worstMs).toBeLessThan(5_000);
  }, 300_000);
});
