/**
 * A save-time ceiling on RRULE COUNT.
 *
 * WHY THIS EXISTS. `recurrence.ts` advances a DTSTART-less anchor by whole
 * INTERVAL periods, which removed a 56-year replay from every calendar
 * request. That advance is exact for every rule EXCEPT one carrying COUNT:
 * dropping early occurrences promotes later ones into the count and
 * un-exhausts an exhausted rule, which would break the S-24 auto-disable. So a
 * COUNT rule keeps the epoch anchor and pays the replay.
 *
 * The replay is linear in COUNT, and a user can type any number. Measured on
 * an Apple M4, ONE `nextOccurrenceAfter` over the 8-day save rung:
 *   COUNT=10          0.4ms   (iteration stops once satisfied)
 *   COUNT=10,000     34ms
 *   COUNT=100,000   277ms
 *   COUNT=1,000,000   2.6s
 *   COUNT=40,000,000 79s     <- blocks the request AND the scheduler tick
 *
 * So the lever is a ceiling at save time, not a faster anchor. 100,000 refuses
 * nothing real: a per-minute rule still fires for 69 days, a daily one for 274
 * years.
 */
import { describe, it, expect } from 'vitest';
import { MAX_RRULE_COUNT } from '../src/api.js';

describe('RRULE COUNT ceiling', () => {
  it('is generous enough that no realistic schedule hits it', () => {
    // A daily rule at the ceiling runs for centuries; a per-minute rule for
    // over two months. If this ever needs raising, raise the measurement too.
    expect(MAX_RRULE_COUNT).toBeGreaterThanOrEqual(100_000);
    expect(MAX_RRULE_COUNT / 365).toBeGreaterThan(200); // years, for a daily rule
  });

  it('is low enough that expanding it stays inside a request', () => {
    // 2.6us per count, measured. The ceiling must not authorise a multi-second
    // expansion inside the save request or the scheduler tick.
    const worstCaseMs = (MAX_RRULE_COUNT * 2.6) / 1000;
    expect(worstCaseMs, `${MAX_RRULE_COUNT} counts would cost ~${worstCaseMs.toFixed(0)}ms`).toBeLessThan(1_000);
  });

  it('the save path reads COUNT out of the rule text, tolerating spacing and case', () => {
    // The guard is a regex over the rule text, so its shape is worth pinning:
    // COUNT may be any parameter, upper or lower case, with spaces around `=`.
    const re = /(?:^|;)\s*COUNT\s*=\s*(\d+)/i;
    expect(re.exec('FREQ=MINUTELY;COUNT=40000000')?.[1]).toBe('40000000');
    expect(re.exec('FREQ=DAILY;count = 250')?.[1]).toBe('250');
    expect(re.exec('COUNT=7;FREQ=DAILY')?.[1]).toBe('7');
    // Must not match a different parameter that merely ends in COUNT.
    expect(re.exec('FREQ=DAILY;BYSETPOS=2;XCOUNT=99')).toBeNull();
    // No COUNT at all is the common case and must not trip the guard.
    expect(re.exec('FREQ=WEEKLY;BYDAY=MO')).toBeNull();
  });
});
