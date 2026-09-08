/**
 * The composer's half of the emitter/expander contract (SCH-1, SCH-4).
 *
 * `packages/shared/fixtures/emittable-schedules.json` is the list of rules the
 * daemon has proved safe to expand. Nothing enforces that the emitter still
 * produces exactly those strings except this file — the UI imports nothing from
 * `@clockwork/shared`, so the compiler cannot see the other side. A rule shape
 * added here without regenerating the fixture fails here; one added to the
 * fixture without an emitter that makes it fails in the daemon.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  INTERVAL_MINUTES, WEEKDAYS, composeIntervalRule, composeWeeklyRule, composeDailyRule, composeMonthlyRule,
  minuteGrid, hourRange, type Weekday,
} from '../src/lib/schedule-rule';

const DAY_SETS: Array<readonly Weekday[]> = [
  ['MO'], ['TU'], ['WE'], ['TH'], ['FR'], ['SA'], ['SU'],
  ['MO', 'WE', 'FR'], ['SA', 'SU'], ['MO', 'TU', 'WE', 'TH', 'FR'], WEEKDAYS,
];
// [3, 4] is a ONE-hour window: with a one-day BYDAY it is the sparsest rule the
// composer can emit, which is the shape most likely to make the expander walk a
// long way for its first five occurrences. It is in the fixture so that walk is
// TIMED in CI rather than reasoned about.
const HOUR_WINDOWS: Array<[number, number]> = [[0, 24], [9, 17], [8, 20], [22, 24], [3, 4]];

const fixture = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../shared/fixtures/emittable-schedules.json'), 'utf8'),
) as { rows: Array<{ id: string; kind: string; rrule: string }> };

describe('the emitter still produces exactly the rules the daemon vetted', () => {
  it('matches the checked-in fixture, row for row', () => {
    const rows: Array<{ id: string; kind: string; rrule: string }> = [];
    for (const [h, m] of [[9, 0], [0, 0], [23, 45]] as Array<[number, number]>) {
      rows.push({ id: `daily-${h}-${m}`, kind: 'rrule', rrule: composeDailyRule(h, m) });
      for (const days of DAY_SETS) {
        rows.push({ id: `weekly-${days.join('')}-${h}-${m}`, kind: 'rrule', rrule: composeWeeklyRule(days, h, m) });
      }
      for (const dom of [1, 15, 28]) {
        rows.push({ id: `monthly-${dom}-${h}-${m}`, kind: 'rrule', rrule: composeMonthlyRule(dom, h, m) });
      }
    }
    for (const every of INTERVAL_MINUTES) {
      for (const days of DAY_SETS) {
        for (const [fromHour, toHour] of HOUR_WINDOWS) {
          rows.push({
            id: `interval-${every}-${days.join('')}-${fromHour}to${toHour}`,
            kind: 'rrule',
            rrule: composeIntervalRule({ every, days, fromHour, toHour }),
          });
        }
      }
    }
    expect(rows).toEqual(fixture.rows);
  });

  it('never emits FREQ=MINUTELY — the spelling that hangs the expander', () => {
    const bad = fixture.rows.filter((r) => /FREQ=(MINUTELY|SECONDLY)/.test(r.rrule));
    expect(bad).toEqual([]);
  });
});

describe('what each control emits', () => {
  it('an interval becomes the minutes of the hour it lands on', () => {
    expect(minuteGrid(5)).toBe('0,5,10,15,20,25,30,35,40,45,50,55');
    expect(minuteGrid(15)).toBe('0,15,30,45');
    expect(minuteGrid(30)).toBe('0,30');
  });

  it('"every 15 minutes, weekdays, 9 to 5" is one HOURLY rule', () => {
    expect(composeIntervalRule({ every: 15, days: ['MO', 'TU', 'WE', 'TH', 'FR'], fromHour: 9, toHour: 17 }))
      .toBe('FREQ=HOURLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,15,30,45');
  });

  it('omits BYDAY and BYHOUR when they would narrow nothing', () => {
    expect(composeIntervalRule({ every: 30, days: WEEKDAYS, fromHour: 0, toHour: 24 }))
      .toBe('FREQ=HOURLY;BYMINUTE=0,30');
  });

  it('the end hour is exclusive', () => {
    expect(hourRange(9, 17)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(hourRange(0, 24)).toHaveLength(24);
    expect(hourRange(22, 24)).toEqual([22, 23]);
  });

  it('weekly takes more than one day — it was single-select', () => {
    expect(composeWeeklyRule(['MO', 'WE', 'FR'], 9, 0)).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0');
  });

  it('days are emitted in week order however they were picked', () => {
    expect(composeWeeklyRule(['FR', 'MO', 'WE'], 9, 0)).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0');
    expect(composeIntervalRule({ every: 15, days: ['SU', 'MO'], fromHour: 0, toHour: 24 }))
      .toBe('FREQ=HOURLY;BYDAY=MO,SU;BYMINUTE=0,15,30,45');
  });

  it('daily and monthly are unchanged', () => {
    expect(composeDailyRule(9, 0)).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
    expect(composeMonthlyRule(15, 9, 30)).toBe('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=30');
  });
});

describe('the WHOLE space the composer can reach, not a sample of it', () => {
  /**
   * The fixture is 221 rules, and the composer can emit far more than that:
   * any of 127 day subsets, any hour window with 0 <= from < to <= 24, four
   * intervals, 1440 times, 28 days of the month. Timing every one of those
   * through the expander is not affordable; asserting a PROPERTY of every one
   * of them is, because the emitter is pure string building.
   *
   * The property is exactly what makes a rule safe to hand to rrule, and the
   * daemon asserts the converse — that a rule with these invariants is
   * classified safe — in emittable-schedules.test.ts. Neither side imports the
   * other; between them the claim is about the whole space rather than a
   * sample of it.
   */
  it('every reachable control state emits a rule with the invariants that make it safe', () => {
    const allDaySets: Weekday[][] = [];
    for (let mask = 1; mask < 1 << 7; mask++) {
      allDaySets.push(WEEKDAYS.filter((_, i) => (mask & (1 << i)) !== 0));
    }
    expect(allDaySets).toHaveLength(127);

    let checked = 0;
    const check = (rrule: string): void => {
      checked++;
      // 1. Never the sub-daily frequencies: those are the two hang classes.
      expect(rrule).not.toMatch(/FREQ=(MINUTELY|SECONDLY)/);
      // 2. HOURLY never states an INTERVAL, so gcd(INTERVAL,24) is 1 and every
      //    BYHOUR value is on the walk — the unreachable case cannot arise.
      if (rrule.startsWith('FREQ=HOURLY')) expect(rrule).not.toMatch(/INTERVAL=/);
      // 3. No COUNT (pins the 1970 anchor) and no DTSTART (nothing to put
      //    off-grid). Both are refusal inputs for the guard.
      expect(rrule).not.toMatch(/COUNT=/);
      expect(rrule).not.toMatch(/DTSTART/);
    };

    for (const days of allDaySets) {
      for (const every of INTERVAL_MINUTES) {
        for (let fromHour = 0; fromHour < 24; fromHour++) {
          for (let toHour = fromHour + 1; toHour <= 24; toHour++) {
            check(composeIntervalRule({ every, days, fromHour, toHour }));
          }
        }
      }
      for (const [h, m] of [[0, 0], [9, 30], [23, 59]] as Array<[number, number]>) {
        check(composeWeeklyRule(days, h, m));
      }
    }
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 1, 30, 59]) {
        check(composeDailyRule(h, m));
        for (let dom = 1; dom <= 28; dom++) check(composeMonthlyRule(dom, h, m));
      }
    }
    // Guards the guard: a typo in the loops above would quietly check nothing.
    expect(checked).toBeGreaterThan(150_000);
  });
});
