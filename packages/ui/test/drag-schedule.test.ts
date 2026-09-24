/**
 * Drag/drop moves (P2): the matrix — every schedule kind × drop day — plus
 * the invariant that only composer shapes are rewritten.
 *
 * Fixed clock: Wednesday 2026-09-23 12:00 UTC. America/New_York is EDT.
 */
import { describe, expect, it } from 'vitest';
import { computeMove, parseEmittedRrule, type MoveSource } from '../src/lib/drag-schedule';

const WED = Date.UTC(2026, 8, 23, 12, 0, 0);
const NY = 'America/New_York';
// Monday 2026-09-28 noon UTC (= 8am EDT, safely future).
const NEXT_MON = Date.UTC(2026, 8, 28, 12, 0, 0);

function src(over: Partial<MoveSource>): MoveSource {
  return { kind: 'once', rrule: null, runAt: null, tz: NY, version: 3, ...over };
}

describe('parseEmittedRrule reads composer shapes only', () => {
  it('weekly/daily/monthly/interval', () => {
    expect(parseEmittedRrule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0')).toMatchObject({ freq: 'WEEKLY', days: ['MO'], hour: 2, minute: 0 });
    expect(parseEmittedRrule('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')).toMatchObject({ freq: 'DAILY', hour: 9, minute: 30 });
    expect(parseEmittedRrule('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0')).toMatchObject({ freq: 'MONTHLY', dom: 15 });
    expect(parseEmittedRrule('FREQ=HOURLY;BYMINUTE=0,15,30,45')).toMatchObject({ freq: 'HOURLY' });
  });

  it('refuses foreign shapes', () => {
    expect(parseEmittedRrule('FREQ=MINUTELY;INTERVAL=5')).toBeNull();
    expect(parseEmittedRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBeNull();
    expect(parseEmittedRrule('FREQ=YEARLY;BYMONTH=3')).toBeNull();
    expect(parseEmittedRrule('FREQ=WEEKLY;BYDAY=XX;BYHOUR=2;BYMINUTE=0')).toBeNull();
    expect(parseEmittedRrule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=25;BYMINUTE=0')).toBeNull();
    expect(parseEmittedRrule('not a rule')).toBeNull();
  });
});

describe('once moves keep the wall time', () => {
  it('moves date, preserves 2am EDT', () => {
    // Original: Thu Sep 24 2am EDT (= 06:00 UTC).
    const r = computeMove(src({ kind: 'once', runAt: Date.UTC(2026, 8, 24, 6, 0) }), NEXT_MON, WED);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.patch.schedule).toMatchObject({ kind: 'once', tz: NY });
    if (r.patch.schedule.kind !== 'once') throw new Error('unreachable');
    // Mon Sep 28 2am EDT = 06:00 UTC.
    expect(r.patch.schedule.runAt).toBe(Date.UTC(2026, 8, 28, 6, 0));
    expect(r.patch.version).toBe(3);
    expect(r.interpretation).toContain('Sep 28');
  });

  it('past drops refuse', () => {
    const past = Date.UTC(2026, 8, 22, 12, 0, 0); // Tuesday, before now
    const r = computeMove(src({ kind: 'once', runAt: Date.UTC(2026, 8, 24, 6, 0) }), past, WED);
    expect(r).toMatchObject({ ok: false, reason: 'past' });
  });
});

describe('weekly moves rewrite the weekday', () => {
  it('single-day weekly MO 2am → drop Monday Sep 28 stays MO; drop Wed Sep 30 → WE', () => {
    const s = src({ kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0' });
    const stay = computeMove(s, NEXT_MON, WED);
    expect(stay.ok && stay.patch.schedule).toMatchObject({ kind: 'rrule', tz: NY });
    if (stay.ok && stay.patch.schedule.kind === 'rrule') {
      expect(stay.patch.schedule.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=2;BYMINUTE=0');
    }
    const wed = Date.UTC(2026, 8, 30, 12, 0, 0);
    const moved = computeMove(s, wed, WED);
    expect(moved.ok && moved.patch.schedule).toMatchObject({ kind: 'rrule' });
    if (moved.ok && moved.patch.schedule.kind === 'rrule') {
      expect(moved.patch.schedule.rrule).toBe('FREQ=WEEKLY;BYDAY=WE;BYHOUR=2;BYMINUTE=0');
      expect(moved.warnings.join(' ')).toMatch(/whole series/);
    }
  });

  it('multi-day weekly refuses as ambiguous', () => {
    const r = computeMove(src({ kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0' }), NEXT_MON, WED);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});

describe('meaningless moves refuse', () => {
  it('daily fires every day already', () => {
    expect(computeMove(src({ kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }), NEXT_MON, WED)).toMatchObject({
      ok: false,
      reason: 'meaningless',
    });
  });

  it('interval runs every few minutes already', () => {
    expect(
      computeMove(src({ kind: 'rrule', rrule: 'FREQ=HOURLY;BYMINUTE=0,15,30,45' }), NEXT_MON, WED),
    ).toMatchObject({ ok: false, reason: 'meaningless' });
  });

  it('cron moves by hand', () => {
    expect(computeMove(src({ kind: 'cron' }), NEXT_MON, WED)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('foreign rules move by editing', () => {
    expect(computeMove(src({ kind: 'rrule', rrule: 'FREQ=MINUTELY;INTERVAL=5' }), NEXT_MON, WED)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });
});

describe('monthly and queue', () => {
  it('monthly 15th → drop on the 20th rewrites BYMONTHDAY', () => {
    const s = src({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0' });
    const r = computeMove(s, Date.UTC(2026, 9, 20, 12, 0, 0), WED);
    expect(r.ok && r.patch.schedule).toMatchObject({ kind: 'rrule' });
    if (r.ok && r.patch.schedule.kind === 'rrule') {
      expect(r.patch.schedule.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=20;BYHOUR=9;BYMINUTE=0');
    }
  });

  it('monthly drop on the 31st refuses (short months)', () => {
    const s = src({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0' });
    // Oct 31 EDT (UTC-4).
    expect(computeMove(s, Date.UTC(2026, 9, 31, 12, 0, 0), WED)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('queue lands as a 9am once, said out loud', () => {
    const r = computeMove(src({ kind: 'queue' }), NEXT_MON, WED);
    expect(r.ok && r.patch.schedule).toMatchObject({ kind: 'once', tz: NY });
    if (r.ok && r.patch.schedule.kind === 'once') {
      // Mon Sep 28 9am EDT = 13:00 UTC.
      expect(r.patch.schedule.runAt).toBe(Date.UTC(2026, 8, 28, 13, 0));
    }
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/9:00 AM/);
  });
});
