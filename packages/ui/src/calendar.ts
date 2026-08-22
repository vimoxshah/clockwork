/**
 * Pure calendar-grid math — unit-tested, no React, no IO.
 * Weeks start Monday (Google-Calendar-style with locale-agnostic fixed start).
 */

export interface GridCell {
  year: number;
  month: number; // 0-based
  day: number;
  /** epoch ms at local midnight of this cell's day */
  ts: number;
  inMonth: boolean;
  isToday: boolean;
}

export interface MonthGrid {
  year: number;
  month: number; // 0-based
  title: string;
  cells: GridCell[];
}

const DAY_MS = 86_400_000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Build a 6×7 month grid (42 cells) starting Monday, with trailing days. */
export function buildMonthGrid(now: Date, viewYear: number, viewMonth: number): MonthGrid {
  const first = new Date(viewYear, viewMonth, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday=0
  const firstCell = new Date(viewYear, viewMonth, 1 - startOffset);
  const todayTs = localMidnight(now);
  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + i);
    cells.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      ts: localMidnight(d),
      inMonth: d.getMonth() === viewMonth,
      isToday: localMidnight(d) === todayTs,
    });
  }
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return { year: viewYear, month: viewMonth, title, cells };
}

/** The Monday-start week containing `anchor`. */
export function buildWeekDays(anchor: Date, now: Date): GridCell[] {
  const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const todayTs = localMidnight(now);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      ts: localMidnight(d),
      inMonth: true,
      isToday: localMidnight(d) === todayTs,
    };
  });
}

/** Local-midnight epoch of today (for range math aligned with grid cells). */
export function todayMidnight(now = new Date()): number {
  return localMidnight(now);
}

/** Shift a (year, month) pair by delta months. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function addDays(ts: number, days: number): number {
  return ts + days * DAY_MS;
}
