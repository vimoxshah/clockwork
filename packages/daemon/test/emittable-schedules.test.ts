/**
 * The contract between the composer and the expander (SCH-1).
 *
 * The UI is a pure wire client and imports nothing from `@clockwork/shared`, so
 * the daemon cannot import the composer's emitter and the composer cannot import
 * this guard. The fixture read below is what joins them: a UI test asserts the
 * emitter still produces exactly these strings, and this file asserts every one
 * of them is safe to expand. A rule added on one side and not the other fails
 * one of the two.
 *
 * TWO START DAYS, ON PURPOSE. The hang this whole design avoids was start-day
 * dependent: `FREQ=MINUTELY;INTERVAL=15;BYDAY=MO..FR;BYHOUR=9..16` answered in
 * 15ms anchored on a Tuesday and hung forever anchored on a Saturday. A suite
 * that only ever expands from a weekday would have shipped it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { guardSchedule } from '../src/schedule-guard.js';
import { occurrencesBetween } from '../src/recurrence.js';

const MAX = 100_000;
const TZ = 'America/New_York';
const DAY = 86_400_000;
/** A Tuesday and a Saturday. The second is the one that used to be fatal. */
const START_DAYS = [Date.UTC(2026, 8, 8, 12, 0, 0), Date.UTC(2026, 8, 12, 12, 0, 0)];
/** The widest save rung that still answers a monthly rule. */
const HORIZON = 70 * DAY;

interface Row { id: string; kind: 'once' | 'rrule' | 'cron'; rrule: string }
const fixture = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../shared/fixtures/emittable-schedules.json'), 'utf8'),
) as { rows: Row[] };

describe('every rule the composer can emit', () => {
  it('has rows to check at all — an empty fixture would pass everything below', () => {
    expect(fixture.rows.length).toBeGreaterThan(200);
  });

  it('is classified safe by the guard', () => {
    const refused = fixture.rows
      .map((r) => ({ id: r.id, verdict: guardSchedule(r.kind, r.rrule, MAX) }))
      .filter((r) => !r.verdict.safe);
    expect(refused).toEqual([]);
  });

  it('yields occurrences from either start day, inside the preview budget', () => {
    const empty: string[] = [];
    const slow: Array<{ id: string; ms: number }> = [];
    for (const row of fixture.rows) {
      for (const from of START_DAYS) {
        const t0 = performance.now();
        const out = occurrencesBetween({ kind: 'rrule', rrule: row.rrule, tz: TZ }, from, from + HORIZON, 5);
        const ms = performance.now() - t0;
        if (out.length === 0) empty.push(`${row.id}@${from}`);
        // 200ms is the budget POST /schedule/preview answers within; the
        // slowest of these measured 15ms, and the shape they replaced hung.
        if (ms > 200) slow.push({ id: `${row.id}@${from}`, ms: Math.round(ms) });
      }
    }
    expect(empty).toEqual([]);
    expect(slow).toEqual([]);
  }, 180_000);
});

describe('the fixture is not vacuously safe', () => {
  it('the FREQ=MINUTELY spelling of an interval rule is refused', () => {
    // The obvious way to write "every 15 minutes on weekdays, 9 to 5", and the
    // one that hangs. If the emitter ever regresses to it, this is the refusal
    // that catches it.
    expect(guardSchedule('rrule', 'FREQ=MINUTELY;INTERVAL=15;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11;BYMINUTE=0,15,30,45', MAX))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });

  it('no emitted rule uses FREQ=MINUTELY or FREQ=SECONDLY at all', () => {
    const subDaily = fixture.rows.filter((r) => /FREQ=(MINUTELY|SECONDLY)/.test(r.rrule)).map((r) => r.id);
    expect(subDaily).toEqual([]);
  });

  it('an unreachable HOURLY rule is still refused, so the HOURLY branch is not a blanket pass', () => {
    expect(guardSchedule('rrule', 'FREQ=HOURLY;INTERVAL=2;BYHOUR=3', MAX))
      .toMatchObject({ safe: false, reason: 'unreachable' });
  });
});

describe('the converse: any rule with the emitter\'s invariants is safe', () => {
  /**
   * The UI side asserts that every one of its ~377,000 reachable control states
   * emits a rule with four invariants (no MINUTELY/SECONDLY, no INTERVAL on
   * HOURLY, no COUNT, no DTSTART). This is the other half of that claim, and
   * together they cover the whole space rather than the fixture's 221 rows.
   *
   * The grammar is rebuilt here from those invariants rather than imported,
   * because the UI is a pure wire client and the packages do not import each
   * other. The fixture equality test on the UI side is what stops the emitter
   * drifting away from this grammar.
   */
  it('across every day subset, hour window and minute grid', () => {
    const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
    const refused: string[] = [];
    let checked = 0;
    for (let mask = 1; mask < 1 << 7; mask++) {
      const days = DAYS.filter((_, i) => (mask & (1 << i)) !== 0);
      const byDay = days.length < 7 ? `BYDAY=${days.join(',')};` : '';
      for (const every of [5, 10, 15, 30]) {
        const grid = Array.from({ length: 60 / every }, (_, i) => i * every).join(',');
        for (let from = 0; from < 24; from++) {
          for (let to = from + 1; to <= 24; to++) {
            const hours = Array.from({ length: Math.max(from, to - 1) - from + 1 }, (_, i) => from + i);
            const byHour = hours.length < 24 ? `BYHOUR=${hours.join(',')};` : '';
            const rule = `FREQ=HOURLY;${byDay}${byHour}BYMINUTE=${grid}`;
            checked++;
            if (!guardSchedule('rrule', rule, MAX).safe) refused.push(rule);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(150_000);
    expect(refused).toEqual([]);
  }, 120_000);
});
