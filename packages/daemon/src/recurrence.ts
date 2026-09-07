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
 * The anchor a DTSTART-less rule used to get, and still gets whenever the
 * advance below cannot be proved set-preserving. It is a fake-UTC instant like
 * every other date in the rrule branch, so its epoch ms is 0.
 */
const EPOCH_DTSTART_LINE = 'DTSTART:19700101T000000Z';
const EPOCH_ANCHOR_MS = 0;

type ParsedRule = InstanceType<typeof RRule>;

/** `DTSTART:` line for a fake-UTC instant — the clock rrule generates in. */
function dtstartLineFor(wallMs: number): string {
  return `DTSTART:${DateTime.fromMillis(wallMs, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss")}Z`;
}

/**
 * How far forward the synthetic epoch anchor may be moved, in fake-UTC ms, or
 * `EPOCH_ANCHOR_MS` to leave it at 1970.
 *
 * WHY THIS EXISTS. `between()` is not a search, it is a replay: the iterator
 * walks from DTSTART one period at a time and only then starts accepting dates
 * (`rrule/dist/esm/iter/index.js`, `if (res >= dtstart)`). A 1970 anchor
 * therefore replays 56 years of history to answer a 31-day question — measured
 * 2026-09-07 on an Apple M4, one `occurrencesBetween` call per sample,
 * median-of-9 in one process, one schedule over one `/calendar` month window:
 * 29.66ms -> 0.108ms for a FREQ=DAILY rule and 6.58ms -> 0.037ms for a
 * FREQ=WEEKLY one, same occurrences either way. It also grows by ~365
 * iterations per schedule per calendar year on its own.
 *
 * WHY IT IS SAFE. Moving the anchor forward by a WHOLE number of INTERVAL
 * periods in the rule's own FREQ unit yields exactly the old occurrence set
 * intersected with `[newAnchor, ∞)`, and nothing else:
 *
 *  - the period grid is a suffix of the old one — the iterator steps by
 *    INTERVAL from DTSTART, and WEEKLY snaps to WKST before stepping
 *    (`DateTime.addWeekly`), so an anchor a whole number of INTERVAL weeks on
 *    lands on the same week grid;
 *  - every component `parseOptions` reads OFF DTSTART is unchanged, because a
 *    whole-day step preserves the time of day, a whole-week step preserves the
 *    weekday, and a whole-month step from the 1st preserves both the day of
 *    the month and midnight;
 *  - the anchor is kept a full period BELOW the padded lower `between()`
 *    bound, so the part of the set that is intersected away is entirely below
 *    the window being asked about.
 *
 * WHEN IT IS NOT. Two refusals, and they are not the same refusal:
 *
 *  - COUNT. It changes WHICH occurrences exist rather than where iteration
 *    starts: dropping the early ones promotes later ones into the count, and
 *    an exhausted rule stops being exhausted. Verified: forcing the advance on
 *    `FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0` turns an empty 2026 window into
 *    three occurrences. This refusal is load-bearing for S-24 auto-disable.
 *  - AN IMPLICIT PHASE. Without BYHOUR+BYMINUTE (DAILY), BYDAY (WEEKLY) or
 *    BYMONTHDAY (MONTHLY), DTSTART itself supplies the time of day, the
 *    weekday or the day of the month, so the rule's identity is tangled up
 *    with its anchor. A whole-period step does preserve those components — see
 *    above — but the module refuses anyway: the phase-carrying parts being
 *    explicit is the condition this fix was scoped and reviewed against, and
 *    all it costs is that those shapes keep today's behaviour.
 *
 * Every other FREQ keeps the epoch anchor too. HOURLY and finer would need
 * their own equivalence argument and are out of scope here.
 *
 * @param rule the rule as parsed WITH the epoch anchor
 * @param notAfterWallMs the padded lower `between()` bound, in fake-UTC ms
 * @returns the fake-UTC ms of the anchor to use; `EPOCH_ANCHOR_MS` for "don't"
 */
function advancedAnchorMs(rule: ParsedRule, notAfterWallMs: number): number {
  const given = rule.origOptions; // ONLY the parts the rule text actually stated
  const { freq, interval } = rule.options;
  if (given.count != null) return EPOCH_ANCHOR_MS;
  // A window at or before the epoch has nothing to advance past. An unparseable
  // bound (NaN) reaches `between()` and throws there today; keeping the epoch
  // anchor keeps that pre-existing contract, and keeps NaN out of the DTSTART.
  if (!(notAfterWallMs > 0)) return EPOCH_ANCHOR_MS;
  // INTERVAL=0 yields no occurrences at all and a negative one spins forever
  // inside rrule 2.8.1 — both are the untouched path's problem, not this one's.
  if (!Number.isInteger(interval) || interval <= 0) return EPOCH_ANCHOR_MS;

  let periodMs: number;
  switch (freq) {
    case RRule.DAILY:
      if (given.byhour == null || given.byminute == null) return EPOCH_ANCHOR_MS;
      periodMs = interval * 86_400_000;
      break;
    case RRule.WEEKLY:
      if (given.byweekday == null) return EPOCH_ANCHOR_MS;
      periodMs = interval * 7 * 86_400_000;
      break;
    case RRule.MONTHLY: {
      if (given.bymonthday == null) return EPOCH_ANCHOR_MS;
      // Months are not a fixed number of milliseconds, so this rung counts
      // calendar months off 1970-01 and lets Luxon do the arithmetic. The
      // result is always day 1 at 00:00:00, which is what leaves an implicit
      // BYHOUR/BYMINUTE/BYSECOND untouched.
      const bound = DateTime.fromMillis(notAfterWallMs, { zone: 'utc' });
      const wholeMonths = (bound.year - 1970) * 12 + (bound.month - 1);
      const periods = Math.floor(wholeMonths / interval) - 1;
      if (periods <= 0) return EPOCH_ANCHOR_MS;
      return DateTime.fromMillis(0, { zone: 'utc' })
        .plus({ months: periods * interval })
        .toMillis();
    }
    default:
      return EPOCH_ANCHOR_MS;
  }
  // One period short of the bound on purpose: `floor` alone would already land
  // at or below it, and the extra period leaves the intersected-away part of
  // the set a whole period clear of the window.
  const periods = Math.floor(notAfterWallMs / periodMs) - 1;
  return periods > 0 ? periods * periodMs : EPOCH_ANCHOR_MS;
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
    // which breaks historical/fake-clock expansion. Synthesize one instead —
    // the between() window is the real boundary — starting from the epoch and
    // then moved forward as far as `advancedAnchorMs` can prove is free.
    const synthetic = !/DTSTART/i.test(ruleText);
    if (synthetic) {
      ruleText = `${EPOCH_DTSTART_LINE}\n${ruleText}`;
    }
    let rule = RRule.fromString(ruleText);
    const lowerBound = new Date(wallBoundFor(fromMsExcl, s.tz).getTime() - WALL_WINDOW_PAD_MS);
    const upperBound = new Date(wallBoundFor(toMsIncl, s.tz).getTime() + WALL_WINDOW_PAD_MS);
    if (synthetic) {
      // A synthesized anchor is ours to move; a caller's DTSTART never is,
      // because there the anchor is part of the schedule the user saved.
      // `EPOCH_DTSTART_LINE` is the prefix just prepended above and `synthetic`
      // means the text carried no DTSTART of its own, so this replaces exactly
      // that line and re-parses down the same path.
      const anchorMs = advancedAnchorMs(rule, lowerBound.getTime());
      if (anchorMs > EPOCH_ANCHOR_MS) {
        rule = RRule.fromString(ruleText.replace(EPOCH_DTSTART_LINE, dtstartLineFor(anchorMs)));
      }
    }
    const between = rule.between(lowerBound, upperBound, true);
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
