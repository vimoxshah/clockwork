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
// Two zones: one west of UTC, and one at +14 — the largest offset in tzdb, and
// the one most likely to slide `occurrencesBetween`'s wall-clock window.
const ZONES = ['America/New_York', 'Pacific/Kiritimati'];
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
    expect(fixture.rows.length).toBeGreaterThan(250);
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
      for (const from of START_DAYS) for (const tz of ZONES) {
        const t0 = performance.now();
        const out = occurrencesBetween({ kind: 'rrule', rrule: row.rrule, tz }, from, from + HORIZON, 5);
        const ms = performance.now() - t0;
        if (out.length === 0) empty.push(`${row.id}@${from}@${tz}`);
        // 200ms is the budget POST /schedule/preview answers within; the
        // slowest of these measured 15ms, and the shape they replaced hung.
        if (ms > 200) slow.push({ id: `${row.id}@${from}@${tz}`, ms: Math.round(ms) });
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

describe('the emitter\'s invariants, and what they do and do not prove', () => {
  /**
   * HONEST ABOUT WHAT THIS IS. The loop below cannot fail as written: with no
   * INTERVAL stated the guard defaults it to 1, gcd(1, 24) is 1, and every
   * BYHOUR value is trivially on the walk — so `{safe: true}` is returned by
   * construction for all 172,800. It is kept as a CANARY: if a future branch
   * ever starts refusing plain FREQ=HOURLY, this is what says so before the
   * composer starts emitting rules the daemon rejects.
   *
   * It is NOT evidence that the emittable space is fast, and after two rounds
   * of review "the guard says safe" is demonstrably not the same claim as
   * "rrule terminates quickly". Expansion TIME is carried by the fixture rows
   * above, which is why the sparsest shapes — one day, one hour, the densest
   * minute grid — are in the fixture rather than left to this loop.
   */
  it('is a canary for the guard turning against FREQ=HOURLY, not a timing proof', () => {

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
