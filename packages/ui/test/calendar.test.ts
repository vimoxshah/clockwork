import { describe, expect, it } from 'vitest';
import { buildMonthGrid, buildWeekDays, shiftMonth, todayMidnight } from '../src/calendar';

describe('buildMonthGrid', () => {
  it('starts on Monday and covers the month with trailing days', () => {
    // Aug 2026: Aug 1 is a Saturday. Grid starts Mon Jul 27.
    const now = new Date(2026, 7, 15);
    const g = buildMonthGrid(now, 2026, 7);
    expect(g.cells).toHaveLength(42);
    const first = g.cells[0]!;
    expect(new Date(first.year, first.month, first.day).getDay()).toBe(1); // Monday
    expect(first.inMonth).toBe(false); // Jul 27 trails
    const aug1 = g.cells.find((c) => c.inMonth && c.day === 1)!;
    expect(aug1.month).toBe(7);
    const last = g.cells[41]!;
    expect(last.inMonth).toBe(false); // Sep trails
    expect(g.title).toContain('August');
  });

  it('marks today correctly', () => {
    const now = new Date(2026, 7, 15);
    const g = buildMonthGrid(now, 2026, 7);
    const todays = g.cells.filter((c) => c.isToday);
    expect(todays).toHaveLength(1);
    expect(todays[0]!.day).toBe(15);
  });

  it('handles February non-leap year without gaps', () => {
    const now = new Date(2025, 1, 10);
    const g = buildMonthGrid(now, 2025, 1); // Feb 2025, Feb 1 = Saturday
    const inMonth = g.cells.filter((c) => c.inMonth);
    expect(inMonth.length).toBe(28);
    expect(inMonth[0]!.day).toBe(1);
    expect(inMonth[27]!.day).toBe(28);
  });
});

describe('buildWeekDays', () => {
  it('returns exactly 7 days starting Monday', () => {
    const now = new Date(2026, 7, 19); // Wednesday Aug 19 2026
    const week = buildWeekDays(now, now);
    expect(week).toHaveLength(7);
    expect(new Date(week[0]!.ts).getDay()).toBe(1);
    expect(week.some((d) => d.isToday)).toBe(true);
    // consecutive
    for (let i = 1; i < 7; i++) {
      expect(week[i]!.ts - week[i - 1]!.ts).toBe(86_400_000);
    }
  });
});

describe('shiftMonth + todayMidnight', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });
  it('todayMidnight strips time', () => {
    const ts = todayMidnight(new Date(2026, 7, 15, 13, 45, 30));
    const d = new Date(ts);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    expect(d.getDate()).toBe(15);
  });
});
