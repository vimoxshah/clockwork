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

/** A BY part rrule parsed into a list: absent reads as `null` or `[]`. */
function statedByPart(part: unknown): boolean {
  return Array.isArray(part) ? part.length > 0 : part != null;
}

/**
 * Does any BY part reject whole DAYS? Those are the parts that make
 * `removeFilteredDays` report `filtered`, and `filtered` is the ONLY thing that
 * makes rrule's sub-daily counter jump by more than one INTERVAL at a time
 * (`DateTime.addMinutes`/`addSeconds` "jump to one iteration before next day").
 * A day-level part is harmless for DAILY and coarser — their `add` ignores the
 * flag entirely — so this is only consulted below HOURLY.
 */
function filtersWholeDays(o: ParsedRule['options']): boolean {
  return (
    statedByPart(o.bymonth) ||
    statedByPart(o.byweekno) ||
    statedByPart(o.byweekday) ||
    statedByPart(o.bynweekday) ||
    statedByPart(o.byyearday) ||
    statedByPart(o.bymonthday) ||
    statedByPart(o.bynmonthday) ||
    o.byeaster != null
  );
}

/**
 * How far forward the synthetic epoch anchor may be moved, in fake-UTC ms, or
 * `EPOCH_ANCHOR_MS` to leave it at 1970.
 *
 * WHY THIS EXISTS. `between()` is not a search, it is a replay: the iterator
 * walks from DTSTART one period at a time and only then starts accepting dates
 * (`rrule/dist/esm/iter/index.js`, `if (res >= dtstart)`). A 1970 anchor
 * therefore replays 56 years of history to answer an 8-day question, and the
 * finer the FREQ the worse it is — measured 2026-09-07 on an Apple M4, ONE
 * `nextOccurrenceAfter` over an 8-day horizon, America/New_York:
 * `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` 25ms, `FREQ=HOURLY` 1,347ms,
 * `FREQ=MINUTELY` 78,941ms. Those are user-creatable rules, and a 79-second
 * expansion is not a slow path: it blocks the API request that saves the task
 * and the scheduler tick that touches the schedule. It also grows on its own,
 * by another year of replay per calendar year.
 *
 * WHY IT IS SAFE. Moving the anchor forward by a WHOLE number of INTERVAL
 * periods IN THE RULE'S OWN FREQ UNIT yields exactly the old occurrence set
 * intersected with `[newAnchor, ∞)`, and nothing else:
 *
 *  - the period grid is a suffix of the old one — the iterator steps by
 *    INTERVAL from DTSTART, and WEEKLY snaps to WKST before stepping
 *    (`DateTime.addWeekly`), so an anchor a whole number of INTERVAL weeks on
 *    lands on the same week grid;
 *  - every component `parseOptions` reads OFF DTSTART is unchanged, and this is
 *    the reason the phase-carrying BY parts need not be stated. The anchor is
 *    always a whole multiple of the FREQ unit measured from 1970-01-01T00:00:00
 *    (or, for MONTHLY, the 1st of a month at midnight), so every finer
 *    component stays at zero and every coarser one stays on its grid: a
 *    whole-day step preserves the time of day (DAILY's implicit
 *    BYHOUR/BYMINUTE/BYSECOND), a whole-week step preserves the weekday
 *    (WEEKLY's implicit BYDAY), a whole-month step from the 1st preserves the
 *    day of the month (MONTHLY's implicit BYMONTHDAY), a whole-hour step
 *    preserves minute and second (HOURLY's implicit BYMINUTE/BYSECOND), a
 *    whole-minute step preserves the second (MINUTELY's implicit BYSECOND);
 *  - the anchor is kept a full period BELOW the padded lower `between()`
 *    bound, so the part of the set that is intersected away is entirely below
 *    the window being asked about. That backoff is load-bearing, not slack:
 *    WEEKLY's first dayset runs from DTSTART's weekday to the next WKST rather
 *    than over a whole week, so the two walks genuinely disagree below the
 *    anchor;
 *  - both walks are then the same deterministic state machine on the same
 *    grid, so they cannot disagree above the anchor.
 *
 * WHEN IT IS NOT. Three refusals, and they are not the same refusal:
 *
 *  - COUNT. It changes WHICH occurrences exist rather than where iteration
 *    starts: dropping the early ones promotes later ones into the count, and
 *    an exhausted rule stops being exhausted. Verified: forcing the advance on
 *    `FREQ=DAILY;COUNT=5;BYHOUR=9;BYMINUTE=0` turns an empty 2026 window into
 *    three occurrences. This refusal is load-bearing for S-24 auto-disable.
 *  - A SUB-DAILY COUNTER THAT CAN LEAVE THE GRID. Below HOURLY the counter walk
 *    stops being plain arithmetic. `DateTime.addMinutes` normalizes its minute
 *    carry through `addHours(hourDiv, false, byhour)`, whose skip loop adds
 *    `hourDiv` hours AGAIN for every hour BYHOUR rejects — a whole number of
 *    hours, which is not a whole number of INTERVAL minutes unless INTERVAL
 *    divides 60. Verified: `FREQ=MINUTELY;INTERVAL=7;BYHOUR=5` walks
 *    00:00 -> 05:03, off the 7-minute grid, and forcing the advance on it
 *    yields 9 occurrences where the epoch anchor yields 8. `addSeconds` carries
 *    the same way through `addMinutes`, so BYHOUR and BYMINUTE are both
 *    hazards for SECONDLY (verified: `FREQ=SECONDLY;INTERVAL=7;BYMINUTE=5`
 *    disagrees). Two ways out, and the gate below accepts either: state no
 *    coarser BY part, so the skip loop never runs; or let INTERVAL divide 60
 *    AND reject no whole day, so every carry is exactly one unit of the next
 *    coarser field and every skip step is one whole hour or minute. HOURLY
 *    needs neither: `addHours` adds exactly INTERVAL hours per step and rechecks
 *    BYHOUR at every step, so it can neither leave the grid nor skip a
 *    matching point.
 *  - A DEGENERATE INTERVAL. INTERVAL=0 yields no occurrences at all and a
 *    negative one walks backwards out of the calendar — both are the untouched
 *    path's problem, not this one's.
 *
 * YEARLY keeps the epoch anchor. A whole-INTERVAL-year step off 1970-01-01
 * preserves everything `parseOptions` reads (month, day of month, time of day)
 * and the probe found it equivalent, but 56 iterations is not a hazard, so it
 * is left on the path it has always been on.
 *
 * A rule whose BY parts are unreachable from its own INTERVAL grid — the
 * clearest one is `FREQ=HOURLY;INTERVAL=2;BYHOUR=3`, whose hours stay even —
 * spins forever inside rrule 2.8.1's skip loop. It does so at EVERY on-grid
 * anchor, because the reachable residues mod 24 depend only on
 * `gcd(INTERVAL, 24)`: verified hanging at both the 1970 anchor and the
 * advanced one, and answering only from a deliberately off-grid anchor. The
 * whole-period discipline preserves that hang exactly as it preserves
 * everything else; it is an upstream defect, reachable today, and out of scope
 * here.
 *
 * @param rule the rule as parsed WITH the epoch anchor
 * @param notAfterWallMs the padded lower `between()` bound, in fake-UTC ms
 * @returns the fake-UTC ms of the anchor to use; `EPOCH_ANCHOR_MS` for "don't"
 */
function advancedAnchorMs(rule: ParsedRule, notAfterWallMs: number): number {
  const o = rule.options;
  const { freq, interval } = o;
  if (rule.origOptions.count != null) return EPOCH_ANCHOR_MS; // as STATED, not as defaulted
  // A window at or before the epoch has nothing to advance past. An unparseable
  // bound (NaN) reaches `between()` and throws there today; keeping the epoch
  // anchor keeps that pre-existing contract, and keeps NaN out of the DTSTART.
  if (!(notAfterWallMs > 0)) return EPOCH_ANCHOR_MS;
  if (!Number.isInteger(interval) || interval <= 0) return EPOCH_ANCHOR_MS;
  // Every carry is exactly one unit of the next coarser field, and every skip
  // step with it, so the walk stays on the INTERVAL grid even when a coarser BY
  // part makes it skip. `60 % interval === 0` also bounds INTERVAL at 60, which
  // is what keeps the carry to a single unit; the day-filter clause is what
  // keeps `filtered`'s multi-unit jump out of the picture.
  const skipStaysOnGrid = 60 % interval === 0 && !filtersWholeDays(o);

  let periodMs: number;
  switch (freq) {
    case RRule.DAILY:
      periodMs = interval * 86_400_000;
      break;
    case RRule.WEEKLY:
      periodMs = interval * 7 * 86_400_000;
      break;
    case RRule.HOURLY:
      periodMs = interval * 3_600_000;
      break;
    case RRule.MINUTELY:
      if (statedByPart(o.byhour) && !skipStaysOnGrid) return EPOCH_ANCHOR_MS;
      periodMs = interval * 60_000;
      break;
    case RRule.SECONDLY:
      if ((statedByPart(o.byhour) || statedByPart(o.byminute)) && !skipStaysOnGrid) return EPOCH_ANCHOR_MS;
      periodMs = interval * 1000;
      break;
    case RRule.MONTHLY: {
      // Months are not a fixed number of milliseconds, so this rung counts
      // calendar months off 1970-01 and lets Luxon do the arithmetic. The
      // result is always day 1 at 00:00:00, which is what leaves an implicit
      // BYMONTHDAY/BYHOUR/BYMINUTE/BYSECOND untouched.
      const bound = DateTime.fromMillis(notAfterWallMs, { zone: 'utc' });
      const wholeMonths = (bound.year - 1970) * 12 + (bound.month - 1);
      const periods = Math.floor(wholeMonths / interval) - 1;
      if (periods <= 0) return EPOCH_ANCHOR_MS;
      return DateTime.fromMillis(0, { zone: 'utc' })
        .plus({ months: periods * interval })
        .toMillis();
    }
    default:
      return EPOCH_ANCHOR_MS; // YEARLY, and anything a later rrule adds
  }
  // One period short of the bound on purpose: `floor` alone would already land
  // at or below it, and the extra period leaves the intersected-away part of
  // the set a whole period clear of the window.
  const periods = Math.floor(notAfterWallMs / periodMs) - 1;
  return periods > 0 ? periods * periodMs : EPOCH_ANCHOR_MS;
}

/**
 * How many occurrences the cron branch walks before it stops, whatever `limit`
 * says. Pre-existing (it was written inline as `Math.min(limit, 200)`); it is
 * named and REPORTED now rather than applied silently, because a caller that
 * asks a year-wide window for 5,000 rows and gets 200 has been cut.
 */
const CRON_EXPANSION_CEILING = 200;

/** An expansion, plus whether it stopped at its own bound instead of the window's. */
export interface BoundedOccurrences {
  /** The EARLIEST occurrences in the window, at most `limit` of them. */
  occurrences: number[];
  /**
   * True when the walk stopped because it reached `limit` (or, for cron,
   * `CRON_EXPANSION_CEILING`), so the window holds MORE than came back. False
   * means what came back is the whole window, and only then is the answer
   * complete.
   */
  truncated: boolean;
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
 *
 * Use `occurrencesBetweenBounded` where the caller has to be able to tell a
 * complete answer from a capped one; this wrapper drops that flag.
 */
export function occurrencesBetween(s: ScheduleLike, fromMsExcl: number, toMsIncl: number, limit = 500): number[] {
  return occurrencesBetweenBounded(s, fromMsExcl, toMsIncl, limit).occurrences;
}

/**
 * `occurrencesBetween`, with the bound it applied made visible.
 *
 * WHY THE STOP MOVED INSIDE `between()`. The contract above always SAID the
 * rrule branch stops as soon as it has `limit` occurrences, and until now only
 * the mapping loop did: `rule.between()` was called bare, so rrule materialized
 * every Date in the padded window first and the cap only trimmed the result.
 * `between()` is a replay (see `advancedAnchorMs`), so the cost was the
 * window's density, never the caller's `limit` — measured on an Apple M4,
 * `FREQ=MINUTELY` over a 365-day window: 525,601 Dates and 820-1,024ms, the
 * SAME at `limit=62` as at `limit=5000`. Passing rrule its `iterator` argument
 * (`between(after, before, inc, iterator)`; returning false stops the walk)
 * makes the cap bound the WORK: the same expansion at `limit=1000` costs 10.9ms.
 *
 * The occurrence list is unchanged by that move, deliberately. The kept
 * occurrences are collected in exactly the old order, sliced at exactly the old
 * point, then deduped and sorted exactly as before — so `nextOccurrenceAfter`,
 * the tick loop's catch-up sweep and the save-time ladder all see what they saw.
 * One extra occurrence past `limit` is collected and dropped, which is what
 * lets `truncated` distinguish "the window holds exactly `limit`" from "the
 * window holds more"; the same `LIMIT n + 1` trick the calendar's runs query
 * uses.
 *
 * @param s the schedule to expand
 * @param fromMsExcl lower bound, EXCLUSIVE (an occurrence exactly here is skipped)
 * @param toMsIncl upper bound, inclusive
 * @param limit the most occurrences to return; the walk stops there
 * @returns the earliest occurrences in the window and whether the bound bit
 */
export function occurrencesBetweenBounded(
  s: ScheduleLike,
  fromMsExcl: number,
  toMsIncl: number,
  limit = 500,
): BoundedOccurrences {
  if (s.kind === 'once') {
    const at = s.runAt != null && s.runAt > fromMsExcl && s.runAt <= toMsIncl ? [s.runAt] : [];
    return { occurrences: at, truncated: false };
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
    // Map and filter INSIDE rrule's own walk, and stop it at `limit` kept
    // occurrences (plus the one that proves there are more). Doing it after the
    // fact would be ~525k luxon conversions for a MINUTELY rule over a year and
    // ~1M over the 732-day horizon — and rrule would have built every one of
    // those Dates before the first conversion. Taking a suffix instead would
    // answer the far end of the horizon rather than the next fire.
    const out: number[] = [];
    rule.between(lowerBound, upperBound, true, (d) => {
      const wall = DateTime.fromJSDate(d, { zone: 'utc' });
      const at = wallTimeToUtcMs(wall, s.tz);
      // The wall window is deliberately loose — truncated to the minute, taken
      // with inc=true, and padded at both ends past any DST transition — so the
      // half-open window is decided HERE, on the real instant, and nowhere else.
      // Dropping `fromMsExcl` itself is load-bearing: the
      // scheduler asks for the next fire after the occurrence it just claimed,
      // and answering with that same instant would freeze next_fire forever
      // behind its own ledger row.
      //
      // A rejected date does NOT stop the walk: the pad is up to 25 hours of
      // occurrences at the near end, and every one of them has to be stepped
      // over before the window proper begins.
      if (at > fromMsExcl && at <= toMsIncl) out.push(at);
      return out.length <= limit;
    });
    const truncated = out.length > limit;
    // `out.slice(0, limit)` is exactly the array the old loop broke out of,
    // element for element, so the dedupe and the sort see what they always saw.
    const kept = truncated ? out.slice(0, limit) : out;
    return { occurrences: [...new Set(kept)].sort((a, b) => a - b), truncated };
  }

  // cron — croner supports IANA tz natively
  const job = new Cron(s.cron ?? '', { name: 'cw-expand', timezone: s.tz, paused: true });
  try {
    const out: number[] = [];
    const cap = Math.min(limit, CRON_EXPANSION_CEILING);
    let cur = new Date(fromMsExcl);
    // `cap + 1` for the same reason as the rrule branch: the extra step is what
    // tells "the window holds exactly `cap`" from "the window holds more".
    for (let i = 0; i < cap + 1; i++) {
      const nextAny = (job as any).nextRun(cur) ?? (job as any)._nextRun?.(cur);
      if (!nextAny) break;
      const next = nextAny as Date;
      if (next.getTime() > toMsIncl) break;
      out.push(next.getTime());
      cur = next;
    }
    const truncated = out.length > cap;
    const kept = truncated ? out.slice(0, cap) : out;
    return { occurrences: kept.sort((a, b) => a - b), truncated };
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
