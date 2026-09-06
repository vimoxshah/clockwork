/**
 * Recurrence expansion + next-fire materialization (arch §4, FR-4).
 * DST rules (normative, S-20/S-21): nonexistent local time fires at the
 * post-transition instant; ambiguous local time fires on the FIRST occurrence
 * (earlier UTC instant). All storage is UTC epoch ms; zones are IANA strings.
 */
import { DateTime } from 'luxon';
import * as cronerNs from 'croner';

// rrule 2.8 ships CJS; Node ESM sees it as default-only. Resolve both shapes.
import * as rruleNs from 'rrule';
const RRule: typeof import('rrule').RRule =
  (rruleNs as any).RRule ?? (rruleNs as any).default?.RRule;
const Cron: typeof cronerNs.Cron =
  (cronerNs as any).Cron ?? (cronerNs as any).default?.Cron;

export interface ScheduleLike {
  kind: 'once' | 'rrule' | 'cron';
  rrule?: string | null;
  cron?: string | null;
  runAt?: number | null;
  tz: string;
}

/** Convert a naive wall-clock component set in `tz` to UTC ms with DST rules. */
export function wallTimeToUtcMs(wall: DateTime, tz: string): number {
  const local = wall.setZone(tz, { keepLocalTime: true });
  // Round-trip detection: does this wall time exist unambiguously?
  const back = local.setZone('utc').setZone(tz);
  if (!local.isValid) {
    // Truly invalid → push forward minute-by-minute until valid (bounded).
    let probe = local.plus({ minutes: 1 });
    for (let i = 0; i < 180 && !probe.isValid; i++) probe = probe.plus({ minutes: 1 });
    return probe.toMillis();
  }
  if (back.hour !== local.hour || back.minute !== local.minute || back.day !== local.day) {
    // Nonexistent local time (spring-forward gap): Luxon shifted it backward;
    // normative rule = POST-transition instant. Shift forward until wall matches.
    let probe = local.plus({ minutes: 1 });
    for (let i = 0; i < 180; i++) {
      const pback = probe.setZone('utc').setZone(tz);
      if (pback.hour === probe.hour && pback.minute === probe.minute && pback.day === probe.day) {
        return probe.toMillis();
      }
      probe = probe.plus({ minutes: 1 });
    }
    return local.toMillis();
  }
  // Ambiguous (fall-back repeat): Luxon's default earlier-offset pick == S-21 first occurrence.
  return local.toMillis();
}

/**
 * Slack added to BOTH `between()` bounds, because wall clock is not a monotone
 * image of the instant line and a DST transition breaks the order in each
 * direction:
 *
 *  - Fall-back pushes instants BELOW the upper wall bound. The clock is set
 *    back, so one wall minute maps to two instants an offset apart:
 *    America/New_York 2026-11-01, 05:00Z and 06:30Z both read as 01:xx local —
 *    a 30-minute wall window over a 90-minute instant window, hiding the 01:45
 *    occurrence (05:45Z) above the upper bound.
 *  - Spring-forward pushes instants ABOVE the lower wall bound. S-20 resolves a
 *    nonexistent local time forward by the whole gap, so America/New_York
 *    2026-03-08 wall 02:45 lands at 03:45 EDT = 07:45Z while wall 03:00 lands
 *    at 07:00Z. At 03:30 EDT the 02:45 fire is fifteen minutes away yet sits
 *    BELOW the lower bound.
 *
 * The pad has to clear twice the largest transition — tzdb's biggest modern one
 * is 2h (Antarctica/Troll) — plus the minute the bounds are truncated to. 25h
 * leaves an order of magnitude of margin, costs at most a day of extra
 * enumeration at each end, and everything it lets in is thrown out by the exact
 * instant filter below, which is the ONLY thing that bounds this window.
 */
const WALL_WINDOW_PAD_MS = 25 * 3_600_000;

/**
 * The `between()` bound for an instant: the fake-UTC Date whose UTC components
 * are that instant's WALL CLOCK in `tz` — the space rrule generates in and
 * `wallTimeToUtcMs` reads back from. Truncated to the minute, so the bound
 * always falls on or before the instant it was built from.
 */
function wallBoundFor(ms: number, tz: string): Date {
  const local = DateTime.fromMillis(ms, { zone: tz });
  // An unresolvable zone yields NaN components, and an Invalid Date bound makes
  // rrule throw instead of degrading. Read the window in UTC in that case and
  // leave wallTimeToUtcMs to produce the NaN instants it already produces.
  const wall = local.isValid ? local : DateTime.fromMillis(ms, { zone: 'utc' });
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
}

/**
 * Enumerate occurrences in (fromMsExclusive, toMsInclusive] in UTC epoch ms.
 * Bounded work per call — the tick loop must stay O(due), never O(history).
 *
 * `limit` caps the result at the EARLIEST `limit` occurrences in the window.
 * All three branches agree on that: `once` yields at most one, `cron` walks
 * forward from `fromMsExcl`, and the rrule branch stops as soon as it has
 * `limit` of them. `nextOccurrenceAfter` depends on it — it asks for one
 * occurrence and reads `found[0]`.
 */
export function occurrencesBetween(s: ScheduleLike, fromMsExcl: number, toMsIncl: number, limit = 500): number[] {
  if (s.kind === 'once') {
    return s.runAt != null && s.runAt > fromMsExcl && s.runAt <= toMsIncl ? [s.runAt] : [];
  }

  if (s.kind === 'rrule') {
    // rrule yields occurrences as fake-UTC Dates whose UTC components ARE the
    // schedule's LOCAL wall clock — wallTimeToUtcMs below is what turns one into
    // an instant — so the window has to be handed to it in that same clock.
    // Building the bounds from the window's UTC components instead compared a
    // wall time against an instant and slid the whole window by the zone offset:
    // west of UTC it swallowed every occurrence in the first |offset| hours
    // after `fromMsExcl` (a 09:00 America/New_York daily materialized at 06:00
    // ET skipped a fire three hours away and landed on the following day), and
    // east of UTC it dropped the last `offset` hours before `toMsIncl`,
    // including an occurrence whose instant is exactly `toMsIncl`.
    let ruleText = s.rrule ?? '';
    // Without an explicit DTSTART the lib anchors at construction-time "now",
    // which breaks historical/fake-clock expansion. Anchor at epoch instead:
    // the between() window is the real boundary.
    if (!/DTSTART/i.test(ruleText)) {
      ruleText = `DTSTART:19700101T000000Z\n${ruleText}`;
    }
    const rule = RRule.fromString(ruleText);
    const between = rule.between(
      new Date(wallBoundFor(fromMsExcl, s.tz).getTime() - WALL_WINDOW_PAD_MS),
      new Date(wallBoundFor(toMsIncl, s.tz).getTime() + WALL_WINDOW_PAD_MS),
      true,
    );
    // Map lazily and stop at `limit` KEPT occurrences. Mapping the whole array
    // first would be ~1M luxon conversions for a MINUTELY rule over the 732-day
    // horizon, and taking a suffix of it would answer the far end of the
    // horizon instead of the next fire.
    const out: number[] = [];
    for (const d of between) {
      const wall = DateTime.fromJSDate(d, { zone: 'utc' });
      const at = wallTimeToUtcMs(wall, s.tz);
      // The wall window is deliberately loose — truncated to the minute, taken
      // with inc=true, and padded at both ends past any DST transition — so the
      // half-open window is decided HERE, on the real instant, and nowhere else.
      // Dropping `fromMsExcl` itself is load-bearing: the
      // scheduler asks for the next fire after the occurrence it just claimed,
      // and answering with that same instant would freeze next_fire forever
      // behind its own ledger row.
      if (at <= fromMsExcl || at > toMsIncl) continue;
      out.push(at);
      if (out.length >= limit) break;
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  // cron — croner supports IANA tz natively
  const job = new Cron(s.cron ?? '', { name: 'cw-expand', timezone: s.tz, paused: true });
  try {
    const out: number[] = [];
    let cur = new Date(fromMsExcl);
    for (let i = 0; i < Math.min(limit, 200); i++) {
      const nextAny = (job as any).nextRun(cur) ?? (job as any)._nextRun?.(cur);
      if (!nextAny) break;
      const next = nextAny as Date;
      if (next.getTime() > toMsIncl) break;
      out.push(next.getTime());
      cur = next;
    }
    return out.sort((a, b) => a - b);
  } finally {
    job.stop();
  }
}

/** First occurrence strictly AFTER afterMs (for next_fire materialization). */
export function nextOccurrenceAfter(s: ScheduleLike, afterMs: number, horizonDays = 366 * 2): number | null {
  const horizon = afterMs + horizonDays * 86_400_000;
  // limit=1 == the EARLIEST occurrence in the window, so found[0] is the next
  // fire. A suffix-limited expansion would hand back the far end of `horizon`.
  const found = occurrencesBetween(s, afterMs, horizon, 1);
  return found.length > 0 ? found[0]! : null; // COUNT-exhausted RRULE → null → auto-disable (S-24)
}
