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
