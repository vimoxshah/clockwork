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
const HOUR_WINDOWS: Array<[number, number]> = [[0, 24], [9, 17], [8, 20], [22, 24]];

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
